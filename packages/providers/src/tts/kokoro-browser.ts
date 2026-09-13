import {
  KOKORO_SAMPLE_RATE,
  toTtsVoices,
  type KokoroDevice,
  type KokoroDtype,
  type KokoroResponse,
  type KokoroWorkerPort,
} from '@latentpresence/ml-web';
import type {
  CancellationSignal,
  SpokenAudioChunk,
  TTSProvider,
  TtsCapabilities,
  TtsRequest,
  TtsVoice,
} from '@latentpresence/protocol';

/**
 * Kokoro in the browser, driven through a worker (P1-T05).
 *
 * The provider owns no model code at all: `packages/ml-web` owns the worker and this owns
 * the conversation with it, which is what lets the whole class be tested in node against a
 * fake port. The split is ADR-11's (`ml-web` is the transformers.js wrapper) and it is
 * about to repeat itself for recognition in P1-T06.
 *
 * **WebGPU is a precondition, not a preference.** Spike A measured synthesis at 245 ms on
 * WebGPU against 3779 ms on wasm, against a 500 ms pipeline budget (ADR-20). Deciding
 * whether this provider can run at all is `kokoroSupport()` in `ml-web`, and steering a
 * user without WebGPU to a server endpoint is the settings UI's job (P1-T10/P1-T13). This
 * class does what it is configured to do: pass `device: 'wasm'` and it will use wasm, and
 * be slow, and say so in no way at all — which is why nothing should pass that without a
 * measurement to justify it.
 */
export interface KokoroBrowserConfig {
  /** Stable provider id. */
  readonly id: string;
  /**
   * How to obtain the worker. A factory rather than a worker so construction is lazy —
   * nothing spawns a thread until something asks for audio — and so tests can hand over
   * a fake port without a DOM. `createKokoroWorker` from `ml-web` is the real one.
   */
  readonly createWorker: () => KokoroWorkerPort;
  /** Defaults to `webgpu`. See the class note before changing it. */
  readonly device?: KokoroDevice;
  /**
   * Defaults to `fp32`, the precision Spike A measured — 325.5 MB against `q8`'s 92.4 MB.
   *
   * **`q8` is quality-equivalent and is still not the default.** Measured 2026-09-12: same
   * loudness, same noise floor, same high-frequency content between words, and Rick could
   * not tell the renderings apart. But that ran on onnxruntime-node, and this provider
   * runs on WebGPU — where ADR-20 already records transformers.js returning *fluent
   * nonsense with no error* from the q8 Moonshine graph. A silent wrong answer is not
   * something a listener catches, so the 233 MB stays unclaimed until P1-T08 can
   * synthesise two different sentences at `q8`/WebGPU and show they differ.
   * `docs/SURFACE.md`.
   */
  readonly dtype?: KokoroDtype;
}

/**
 * A promise-backed FIFO for worker messages.
 *
 * The worker pushes whenever it likes and the generator pulls when it is ready; without a
 * queue between them a message that arrives while nothing is awaiting is simply lost.
 */
class MessageQueue<T> {
  private readonly items: T[] = [];
  private readonly waiting: ((item: T) => void)[] = [];

  push(item: T): void {
    const resolve = this.waiting.shift();
    if (resolve === undefined) this.items.push(item);
    else resolve(item);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.waiting.push(resolve));
  }
}

export class KokoroBrowserTTSProvider implements TTSProvider {
  readonly id: string;
  private readonly config: KokoroBrowserConfig;
  private port: KokoroWorkerPort | null = null;
  private detach: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<(message: KokoroResponse) => void>();
  private nextRequestId = 0;

  constructor(config: KokoroBrowserConfig) {
    this.id = config.id;
    this.config = config;
  }

  async capabilities(): Promise<TtsCapabilities> {
    return {
      // Per sentence, which is the granularity kokoro-js's splitter emits at.
      streaming: true,
      // Kokoro returns samples and nothing else. P2 gets its viseme timing from
      // wawa-lipsync analysis of the audio instead.
      wordTimestamps: false,
      // There is no emotion control on this model. `speed` is honoured because
      // `TtsRequest` carries it in its own right, but a hint is dropped, and saying so
      // here is what lets the affect engine compensate rather than assume.
      emotionHints: false,
      styleTags: false,
      runsInBrowser: true,
      sampleRate: KOKORO_SAMPLE_RATE,
    };
  }

  /** The built-in voice table. No worker, no download: the settings UI has to be able to
   * show this before the user consents to fetching any weights (ADR-09). */
  async listVoices(): Promise<TtsVoice[]> {
    return toTtsVoices();
  }

  /**
   * Synthesise one sentence.
   *
   * Chunks are held one behind so the last can be marked `isFinal` — the worker does not
   * announce a last chunk, it announces `done` after it. Exactly one chunk per call
   * carries `isFinal: true`, including when the call is cancelled or produced no audio at
   * all, so the output queue always gets its release (P1-T08).
   */
  async *synthesize(
    request: TtsRequest,
    options?: { signal?: CancellationSignal },
  ): AsyncIterable<SpokenAudioChunk> {
    const port = await this.ready();
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const queue = new MessageQueue<KokoroResponse>();
    const listener = (message: KokoroResponse): void => {
      if ('requestId' in message && message.requestId === requestId) queue.push(message);
      else if (message.type === 'error' && message.requestId === null) queue.push(message);
    };
    this.listeners.add(listener);

    const cancel = (): void => port.post({ type: 'cancel', requestId });
    options?.signal?.addEventListener('abort', cancel);
    if (options?.signal?.aborted === true) cancel();

    let startMs = 0;
    let held: SpokenAudioChunk | null = null;

    try {
      port.post({
        type: 'speak',
        requestId,
        text: request.text,
        voice: request.voiceId,
        speed: request.speed,
      });

      for (;;) {
        const message = await queue.next();
        if (message.type === 'error') throw new Error(`${this.id}: ${message.message}`);
        if (message.type === 'done') break;
        if (message.type !== 'audio') continue;

        if (held !== null) yield held;
        held = {
          samples: message.samples,
          sampleRate: message.sampleRate,
          startMs,
          isFinal: false,
        };
        startMs += (message.samples.length / message.sampleRate) * 1000;
      }
    } finally {
      options?.signal?.removeEventListener('abort', cancel);
      this.listeners.delete(listener);
    }

    yield held === null
      ? { samples: new Float32Array(0), sampleRate: KOKORO_SAMPLE_RATE, startMs, isFinal: true }
      : { ...held, isFinal: true };
  }

  /** Stop the worker. The provider is usable again afterwards: the next call loads a new
   * one, which is what a settings change (device, dtype) needs. */
  terminate(): void {
    this.detach?.();
    this.port?.terminate();
    this.detach = null;
    this.port = null;
    this.loading = null;
  }

  /** The loaded worker. Single-flight: two sentences arriving together load once. */
  private async ready(): Promise<KokoroWorkerPort> {
    if (this.port === null) {
      const port = this.config.createWorker();
      this.port = port;
      this.detach = port.onMessage((message) => {
        // Iterating the Set directly is safe: a listener that removes itself during
        // dispatch is defined behaviour, and nothing adds one from inside a dispatch.
        for (const listener of this.listeners) listener(message);
      });
    }
    const port = this.port;

    this.loading ??= new Promise<void>((resolve, reject) => {
      const listener = (message: KokoroResponse): void => {
        if (message.type === 'ready') {
          this.listeners.delete(listener);
          resolve();
        } else if (message.type === 'error' && message.requestId === null) {
          this.listeners.delete(listener);
          // A failed load must not be cached as a failure for ever: a user who was shown
          // the consent screen and declined can grant it and try again.
          this.loading = null;
          reject(new Error(`${this.id}: ${message.message}`));
        }
      };
      this.listeners.add(listener);
      port.post({
        type: 'load',
        device: this.config.device ?? 'webgpu',
        dtype: this.config.dtype ?? 'fp32',
      });
    });

    await this.loading;
    return port;
  }
}
