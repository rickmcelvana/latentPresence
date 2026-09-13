import type { VadFrame } from '@latentpresence/core';
import { VAD_FRAME_SAMPLES, type VadResponse, type VadWorkerPort } from '@latentpresence/ml-web';

/**
 * Silero VAD driven through a worker (P1-T07): 512-sample frames in, `VadFrame`s out, in
 * capture order.
 *
 * Its output is exactly what `TurnDetector.push` takes, so wiring the two is
 * `vad.onFrame((frame) => detector.push(frame))`. Frames go to the worker by transfer and
 * come back by transfer, so the audio is never copied on the way through.
 *
 * Audio arrives here already at 16 kHz — resampled **once**, upstream, so the VAD, the
 * judge and recognition all read the same samples (P1-T07 brief, "Sample rates").
 */
export interface BrowserVadConfig {
  readonly createWorker: () => VadWorkerPort;
}

export class BrowserSileroVad {
  private readonly config: BrowserVadConfig;
  private port: VadWorkerPort | null = null;
  private detach: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private readonly frameListeners = new Set<(frame: VadFrame) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly loadListeners = new Set<(message: VadResponse) => void>();

  constructor(config: BrowserVadConfig) {
    this.config = config;
  }

  /** Load Silero. Frames pushed before this resolves are refused, not queued. */
  async load(): Promise<void> {
    if (this.port === null) {
      const port = this.config.createWorker();
      this.port = port;
      this.detach = port.onMessage((message) => this.onMessage(message));
    }
    const port = this.port;
    this.loading ??= new Promise<void>((resolve, reject) => {
      const listener = (message: VadResponse): void => {
        if (message.type === 'ready') {
          this.loadListeners.delete(listener);
          this.loaded = true;
          resolve();
        } else if (message.type === 'error') {
          this.loadListeners.delete(listener);
          this.loading = null;
          reject(new Error(`silero-vad: ${message.message}`));
        }
      };
      this.loadListeners.add(listener);
      port.post({ type: 'load' });
    });
    await this.loading;
  }

  /**
   * Send one frame. **The buffer is transferred**: `samples` is empty afterwards, and the
   * same samples come back on the `VadFrame`.
   *
   * Refuses rather than drops a frame before load. A microphone started ahead of its VAD
   * is a wiring mistake, and a silently discarded opening is the first word of a turn.
   */
  push(samples: Float32Array, at: number): void {
    const port = this.port;
    if (!this.loaded || port === null) throw new Error('silero-vad: push before load');
    if (samples.length !== VAD_FRAME_SAMPLES) {
      throw new Error(`silero-vad: frames must be ${VAD_FRAME_SAMPLES} samples at 16 kHz, got ${samples.length}`);
    }
    port.post({ type: 'frame', samples, at }, [samples.buffer]);
  }

  /** Every classified frame, in the order pushed. Returns an unsubscribe function. */
  onFrame(listener: (frame: VadFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /** A frame the model failed on. The stream carries on; the detector sees a gap. */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** Clear Silero's recurrent state, behind any frames already sent. */
  reset(): void {
    this.port?.post({ type: 'reset' });
  }

  terminate(): void {
    this.detach?.();
    this.port?.terminate();
    this.detach = null;
    this.port = null;
    this.loading = null;
    this.loaded = false;
  }

  private onMessage(message: VadResponse): void {
    for (const listener of Array.from(this.loadListeners)) listener(message);
    if (message.type === 'probability') {
      const frame: VadFrame = { samples: message.samples, probability: message.probability, at: message.at };
      for (const listener of Array.from(this.frameListeners)) listener(frame);
    } else if (message.type === 'error' && this.loaded) {
      const error = new Error(`silero-vad: ${message.message}`);
      for (const listener of Array.from(this.errorListeners)) listener(error);
    }
  }
}
