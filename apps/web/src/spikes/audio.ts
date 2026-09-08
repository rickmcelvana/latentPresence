import { FRAME_SAMPLES } from './frames';

/**
 * Microphone in, speaker out, for Spike A.
 *
 * The one subtle thing here is the clock. `performance.now()` is not available inside an
 * AudioWorklet, and stamping frames when they arrive on the main thread would fold
 * message-port latency into every measurement. So the worklet reports the AudioContext
 * clock, and this module converts with an offset measured once — giving marks that track
 * the audio itself rather than when the main thread got round to looking.
 */

/**
 * The capture worklet, as source. It is a string because a `.ts` worklet needs build
 * configuration that a throwaway spike does not deserve, and a Blob URL works the same
 * in dev and in a build. Fifteen lines of plain JS: accumulate quanta into the frame
 * size Silero wants, and send the audio clock with each one.
 */
const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.frameSamples;
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === this.size) {
        const frame = this.buffer.slice();
        // currentTime is the start of this quantum; close enough for a frame boundary.
        this.port.postMessage({ frame, time: currentTime }, [frame.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('spike-capture', CaptureProcessor);
`;

export interface CaptureHandle {
  /** What the browser calls the input device, for the write-up. */
  readonly deviceLabel: string;
  /** What the device is actually running at, before the graph resamples. */
  readonly deviceSampleRate: number | null;
  /** What the VAD and the recogniser see. Forced to 16 kHz. */
  readonly graphSampleRate: number;
  stop(): Promise<void>;
}

/**
 * Open the default microphone and deliver 512-sample frames at 16 kHz.
 *
 * The AudioContext is constructed at 16 kHz so the browser's own resampler does the
 * conversion; the device's native rate is reported separately rather than assumed,
 * because a headset at 48 kHz and an interface at 44.1 kHz do not resample identically.
 */
export async function startCapture(
  onFrame: (samples: Float32Array, at: number) => void,
): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings() ?? {};

  const context = new AudioContext({ sampleRate: 16_000 });
  const moduleUrl = URL.createObjectURL(
    new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }),
  );
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }

  // Measured once, then held: performance.now() and AudioContext.currentTime run at the
  // same rate, so one offset converts every frame.
  const clockOffset = performance.now() - context.currentTime * 1000;

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'spike-capture', {
    processorOptions: { frameSamples: FRAME_SAMPLES },
  });
  // Assigning `onmessage` implicitly starts the port; `addEventListener` would need an
  // explicit `port.start()`, which is easy to forget and fails silently.
  // eslint-disable-next-line unicorn/prefer-add-event-listener
  node.port.onmessage = (event: MessageEvent<{ frame: Float32Array; time: number }>) => {
    onFrame(event.data.frame, event.data.time * 1000 + clockOffset);
  };
  source.connect(node);
  // The worklet emits nothing downstream, but Chrome will not pull from a node that
  // reaches no destination. A zero gain keeps the graph alive without an echo.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);

  return {
    deviceLabel: track?.label ?? 'unknown',
    deviceSampleRate: settings.sampleRate ?? null,
    graphSampleRate: context.sampleRate,
    async stop() {
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      await context.close();
    },
  };
}

/**
 * Plays synthesised chunks back to back and reports when the first one is *scheduled to
 * start* — not when synthesis returned, which is a different and flattering number.
 */
export class Playback {
  private context: AudioContext | null = null;
  private nextStart = 0;
  private clockOffset = 0;

  /** Returns the performance-clock time the chunk will begin sounding. */
  enqueue(samples: Float32Array, sampleRate: number): number {
    if (this.context === null || this.context.sampleRate !== sampleRate) {
      void this.context?.close();
      this.context = new AudioContext({ sampleRate });
      this.clockOffset = performance.now() - this.context.currentTime * 1000;
      this.nextStart = 0;
    }
    const context = this.context;

    const buffer = context.createBuffer(1, samples.length, sampleRate);
    // `set` rather than `copyToChannel`: the latter is typed against
    // Float32Array<ArrayBuffer>, and a transferred buffer arrives as ArrayBufferLike.
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime, this.nextStart);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;

    return startAt * 1000 + this.clockOffset;
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.nextStart = 0;
  }
}
