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
      node.disconnect();
      await context.close();
    },
  };
}

export interface MicrophoneHandle {
  /** What the browser calls the input device. */
  readonly deviceLabel: string;
  readonly context: AudioContext;
  stop(): Promise<void>;
}

/**
 * Open the default microphone and deliver `frameSamples` frames at `sampleRate` — 512 at
 * 16 kHz by default, Silero's geometry. `at` is in ms on the `performance.now()` clock,
 * converted from the context clock with one offset measured at start.
 *
 * Echo cancellation is requested. Whether Chrome's cancels audio this page plays through
 * Web Audio is exactly what P1-T08 could not settle without a person and speakers.
 */
export async function startMicrophone(
  onFrame: (samples: Float32Array, at: number) => void,
  options: { sampleRate?: number; frameSamples?: number } = {},
): Promise<MicrophoneHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const track = stream.getAudioTracks()[0];
  const context = new AudioContext({ sampleRate: options.sampleRate ?? 16_000 });
  await context.audioWorklet.addModule(captureWorkletUrl);
  const clockOffset = performance.now() - context.currentTime * 1000;

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
    processorOptions: { frameSamples: options.frameSamples ?? 512 },
  });
  const handler = (event: MessageEvent<CaptureMessage>): void => {
    onFrame(event.data.samples, event.data.time * 1000 + clockOffset);
  };
  node.port.addEventListener('message', handler);
  node.port.start();
  source.connect(node);
  // Chrome does not pull a node that reaches no destination; a zero gain keeps it alive silently.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);

  return {
    deviceLabel: track?.label ?? 'unknown',
    context,
    async stop() {
      node.port.removeEventListener('message', handler);
      node.disconnect();
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      await context.close();
    },
  };
}
