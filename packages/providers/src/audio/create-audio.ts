import captureWorkletUrl from './capture.worklet.ts?worker&url';
import playbackWorkletUrl from './playback.worklet.ts?worker&url';
import { BrowserAudioOutput } from './browser-output';
import {
  CAPTURE_PROCESSOR,
  PLAYBACK_PROCESSOR,
  type CaptureMessage,
  type PlaybackRequest,
  type PlaybackResponse,
} from './messages';

/**
 * The real audio graph (P1-T08). Nothing here runs in node, so it has no test: the parts
 * worth testing are `PlaybackRenderer` and `BrowserAudioOutput`, which test against a fake
 * port. Same split as `ml-web`'s `create-worker.ts`.
 *
 * `?worker&url` is how the worklets reach the page: Vite bundles each into its own chunk
 * and hands back its URL, in dev and in a production build alike (`docs/SURFACE.md`,
 * 2026-09-13). A plain `new URL('./x.ts', import.meta.url)` is only rewritten for `Worker`.
 */

/** The rate both TTS providers produce. */
export const OUTPUT_SAMPLE_RATE = 24_000;

/**
 * **Chrome slows an AudioContext whose output has been digital silence for ~30 s.**
 * Measured 2026-09-13 in the Browser pane (Chrome 152, page hidden; `docs/SURFACE.md`):
 * four contexts side by side, all rendering at 1.00× real time for 30 s, then the two
 * whose output was exactly zero fell to **0.64×** and stayed there, while a 200 Hz tone at
 * −60 dB and one at −100 dB held 1.00× for the whole minute. The capture context's output
 * is always silence (it exists to be pulled, not heard), so after half a minute every
 * microphone frame arrived later than the last — ten seconds behind within a minute — and
 * turn detection and barge-in, which run on frame time, went with them.
 *
 * So both contexts carry a tone the device cannot reproduce: 1e-5 is −100 dB, under one
 * step of 16-bit output. Whether a *visible* page is affected was not measured; the pane
 * was hidden throughout, and a user who switches tabs mid-conversation is a real case.
 */
export const KEEP_ALIVE_GAIN = 1e-5;

/** Connect an inaudible tone to the context's destination, so it never renders silence. Returns a stop function. */
export function keepAlive(context: AudioContext): () => void {
  const tone = context.createOscillator();
  tone.frequency.value = 200;
  const level = context.createGain();
  level.gain.value = KEEP_ALIVE_GAIN;
  tone.connect(level).connect(context.destination);
  tone.start();
  return () => {
    tone.stop();
    level.disconnect();
  };
}

export interface AudioOutputHandle {
  readonly output: BrowserAudioOutput;
  readonly context: AudioContext;
  /** The worklet node, for anything that wants to tap the voice (P2 lip sync). */
  readonly node: AudioWorkletNode;
  close(): Promise<void>;
}

/**
 * Build the output graph. Call from a user gesture: the autoplay policy leaves a context
 * created without one suspended, and a suspended context renders nothing.
 */
export async function createAudioOutput(sampleRate = OUTPUT_SAMPLE_RATE): Promise<AudioOutputHandle> {
  const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  await context.resume();
  await context.audioWorklet.addModule(playbackWorkletUrl);
  const node = new AudioWorkletNode(context, PLAYBACK_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  node.connect(context.destination);
  // Between answers the voice is silent for as long as the user takes to reply.
  const stopKeepAlive = keepAlive(context);

  const output = new BrowserAudioOutput({
    sampleRate: context.sampleRate,
    clock: () => context.currentTime,
    outputLatency: () => context.outputLatency || 0,
    port: {
      post(message: PlaybackRequest, transfer: readonly Transferable[] = []): void {
        node.port.postMessage(message, [...transfer]);
      },
      onMessage(listener: (message: PlaybackResponse) => void): () => void {
        const handler = (event: MessageEvent<PlaybackResponse>): void => listener(event.data);
        node.port.addEventListener('message', handler);
        // `addEventListener` on a MessagePort does not start it; `onmessage` would.
        node.port.start();
        return () => node.port.removeEventListener('message', handler);
      },
    },
  });

  return {
    output,
    context,
    node,
    async close() {
      output.dispose();
      stopKeepAlive();
      node.disconnect();
      await context.close();
    },
  };
}

export interface CaptureHandle {
  /** What the source calls itself: the input device's label, or the simulator's name. */
  readonly deviceLabel: string;
  readonly context: AudioContext;
  stop(): Promise<void>;
}

/** Something that feeds the capture graph: connect to `input`, return how to disconnect. */
export type CaptureSource = (
  context: AudioContext,
  input: AudioNode,
) => Promise<{ readonly label: string; stop(): void }>;

export interface CaptureOptions {
  /** 16 kHz by default: Silero, Smart Turn and recognition all read it. */
  readonly sampleRate?: number;
  /** 512 by default, Silero v5's frame. */
  readonly frameSamples?: number;
}

/**
 * Deliver `frameSamples` frames at `sampleRate` from any source. `at` is in ms on the
 * `performance.now()` clock, converted from the context clock with one offset measured at
 * start. Frames are produced on the audio thread, so they keep real time in a background
 * tab where page timers are throttled.
 */
export async function startCapture(
  source: CaptureSource,
  onFrame: (samples: Float32Array, at: number) => void,
  options: CaptureOptions = {},
): Promise<CaptureHandle> {
  const context = new AudioContext({ sampleRate: options.sampleRate ?? 16_000 });
  await context.resume();
  await context.audioWorklet.addModule(captureWorkletUrl);
  const clockOffset = performance.now() - context.currentTime * 1000;

  const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
    processorOptions: { frameSamples: options.frameSamples ?? 512 },
  });
  const handler = (event: MessageEvent<CaptureMessage>): void => {
    onFrame(event.data.samples, event.data.time * 1000 + clockOffset);
  };
  node.port.addEventListener('message', handler);
  node.port.start();
  // Chrome does not pull a node that reaches no destination; a zero gain keeps it in the
  // graph without an echo. Zero alone is not enough to keep it in real time — `keepAlive`.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);
  const stopKeepAlive = keepAlive(context);
  const connected = await source(context, node);

  return {
    deviceLabel: connected.label,
    context,
    async stop() {
      node.port.removeEventListener('message', handler);
      connected.stop();
      stopKeepAlive();
      node.disconnect();
      await context.close();
    },
  };
}

/**
 * The default microphone as a capture source. Echo cancellation is requested; whether
 * Chrome's cancels audio this page plays through Web Audio is what P1-T08 could not settle
 * without a person and speakers.
 */
export const microphoneSource: CaptureSource = async (context, input) => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const source = context.createMediaStreamSource(stream);
  source.connect(input);
  return {
    label: stream.getAudioTracks()[0]?.label ?? 'unknown microphone',
    stop() {
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
    },
  };
};
