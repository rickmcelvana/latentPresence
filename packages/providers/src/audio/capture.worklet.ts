import type { CaptureMessage } from './messages';
import { CAPTURE_PROCESSOR } from './messages';

/**
 * Microphone frames on the audio thread (P1-T08, promoted from Spike A's `spike-capture`).
 * Accumulates render quanta into `frameSamples` and posts each frame with the context time
 * of its first sample, so frame times track the audio rather than when the main thread
 * got round to looking.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options: { processorOptions: { frameSamples: number } }) => AudioWorkletProcessor,
): void;
declare const currentTime: number;
declare const sampleRate: number;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly size: number;
  private buffer: Float32Array;
  private filled = 0;
  private startedAt = 0;

  constructor(options: { processorOptions: { frameSamples: number } }) {
    super();
    this.size = options.processorOptions.frameSamples;
    this.buffer = new Float32Array(this.size);
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel === undefined) return true;
    for (let i = 0; i < channel.length; i += 1) {
      if (this.filled === 0) this.startedAt = currentTime + i / sampleRate;
      this.buffer[this.filled] = channel[i] ?? 0;
      this.filled += 1;
      if (this.filled === this.size) {
        const message: CaptureMessage = { samples: this.buffer, time: this.startedAt };
        this.port.postMessage(message, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
