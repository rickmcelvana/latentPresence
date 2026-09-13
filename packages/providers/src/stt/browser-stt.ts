import {
  ASR_MODELS,
  ASR_SAMPLE_RATE,
  combinationBlocker,
  type AsrDevice,
  type AsrDtype,
  type AsrModelKey,
  type AsrResponse,
  type AsrWorkerPort,
} from '@latentpresence/ml-web';
import type {
  AudioChunk,
  ProviderCallOptions,
  STTProvider,
  SttCapabilities,
  SttResult,
} from '@latentpresence/protocol';
import { isAborted } from './signal';

/**
 * Recognition in the browser, driven through a worker (P1-T06).
 *
 * The same split as `KokoroBrowserTTSProvider`: `packages/ml-web` owns the model code,
 * this owns the conversation with it, and the whole class is testable in node against a
 * fake port. Moonshine and Whisper differ only in what they can report, so they are one
 * implementation with two configurations rather than two near-identical files.
 *
 * **Neither model streams.** Both are encoder-decoder models that consume a whole
 * utterance, so `transcribe` drains its audio, transcribes once, and yields a single
 * `isFinal` result. That is not a limitation this class imposes — `capabilities()` says
 * `streaming: false` so the UI shows no partial text and waits, rather than leaving the
 * user watching a caret that will never move.
 *
 * **Cancellation is the load-bearing behaviour, not an edge case.** ADR-21 starts
 * recognition on a candidate window in parallel with turn detection, and discards it when
 * the turn turns out not to be over — so being cancelled mid-transcription is the *common*
 * path. A cancelled call yields nothing at all: no partial, no empty final, nothing for
 * the transcript to have to retract.
 */
export interface BrowserSttConfig {
  /** Stable provider id. */
  readonly id: string;
  /**
   * How to obtain the worker. A factory rather than a worker so construction is lazy and
   * tests can hand over a fake port without a DOM. `createAsrWorker` from `ml-web` is the
   * real one.
   */
  readonly createWorker: () => AsrWorkerPort;
  readonly model: AsrModelKey;
  /** Defaults to `webgpu`. Spike A measured recognition at 180 ms there. */
  readonly device?: AsrDevice;
  /**
   * Defaults to `fp32`, the precision Spike A measured.
   *
   * A quantised precision on WebGPU is refused outright rather than defaulted away from:
   * ADR-20 records that path returning the same fluent sentence for every utterance with
   * no error, and a silently wrong transcript poisons the transcript, the memory store and
   * the model's next turn at once.
   */
  readonly dtype?: AsrDtype;
  /** BCP-47 hint for a multilingual model. Null asks it to detect. Ignored by Moonshine. */
  readonly language?: string | null;
}

/**
 * A promise-backed FIFO for worker messages. The worker pushes whenever it likes and the
 * caller pulls when ready; without a queue a message arriving while nothing awaits is lost.
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

/**
 * Join a stream of microphone chunks into one buffer.
 *
 * Chunks are asserted to share a sample rate. They come from one `AudioWorklet` on one
 * device, so a change mid-utterance means something upstream is wrong, and concatenating
 * across it would produce audio that speeds up halfway through — the same silent
 * corruption resampling exists to prevent, arriving by a different door.
 */
async function drain(
  audio: AsyncIterable<AudioChunk>,
  signal: ProviderCallOptions['signal'],
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const parts: Float32Array[] = [];
  let sampleRate = 0;
  let total = 0;

  for await (const chunk of audio) {
    if (isAborted(signal)) break;
    if (sampleRate === 0) sampleRate = chunk.sampleRate;
    else if (chunk.sampleRate !== sampleRate) {
      throw new Error(
        `sample rate changed mid-utterance: ${sampleRate} Hz then ${chunk.sampleRate} Hz`,
      );
    }
    parts.push(chunk.samples);
    total += chunk.samples.length;
  }

  const samples = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  return { samples, sampleRate: sampleRate === 0 ? ASR_SAMPLE_RATE : sampleRate };
}

export class BrowserSTTProvider implements STTProvider {
  readonly id: string;
  private readonly config: BrowserSttConfig;
  private port: AsrWorkerPort | null = null;
  private detach: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<(message: AsrResponse) => void>();
  private nextRequestId = 0;

  constructor(config: BrowserSttConfig) {
    const blocker = combinationBlocker(config.device ?? 'webgpu', config.dtype ?? 'fp32');
    // Fail at construction, not at first speech. A settings screen can show this while
    // the user is still choosing; a microphone that silently records nothing usable
    // cannot be explained after the fact.
    if (blocker !== null) throw new Error(`${config.id}: ${blocker}`);
    this.id = config.id;
    this.config = config;
  }

  async capabilities(): Promise<SttCapabilities> {
    const spec = ASR_MODELS[this.config.model];
    return {
      streaming: false,
      wordTimestamps: spec.wordTimestamps,
      // Whisper's multilingual checkpoints do detect a language, but transformers.js
      // 3.8.1 consumes it internally and exports no way to read it back, so claiming
      // detection here would promise something no caller could ever receive.
      languageDetection: false,
      runsInBrowser: true,
      languages: [...spec.languages],
    };
  }

  /**
   * Transcribe one utterance.
   *
   * Yields at most one result. A cancelled call yields none — deliberately: the caller
   * that cancelled is the one that decided the audio was not a turn, and handing it a
   * partial would make discarding it someone else's job.
   */
  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    options?: ProviderCallOptions,
  ): AsyncIterable<SttResult> {
    const port = await this.ready();
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const queue = new MessageQueue<AsrResponse>();
    const listener = (message: AsrResponse): void => {
      if ('requestId' in message && message.requestId === requestId) queue.push(message);
      else if (message.type === 'error' && message.requestId === null) queue.push(message);
    };
    this.listeners.add(listener);

    const cancel = (): void => port.post({ type: 'cancel', requestId });
    options?.signal?.addEventListener('abort', cancel);

    try {
      // Draining happens before the worker is told anything, so an utterance cancelled
      // while the user is still speaking costs no model time at all.
      const { samples, sampleRate } = await drain(audio, options?.signal);
      if (isAborted(options?.signal)) return;

      port.post(
        {
          type: 'transcribe',
          requestId,
          samples,
          sampleRate,
          language: this.config.language ?? null,
        },
        // The buffer is transferred: an utterance is hundreds of thousands of samples and
        // this thread has no further use for them.
        [samples.buffer],
      );

      for (;;) {
        const message = await queue.next();
        if (message.type === 'error') throw new Error(`${this.id}: ${message.message}`);
        if (message.type === 'cancelled') return;
        if (message.type !== 'result') continue;
        yield {
          text: message.text,
          isFinal: true,
          // Neither model reports one, and a fabricated 1.0 would tell the turn machine
          // it can trust a transcript nothing has vouched for.
          confidence: null,
          language: message.language,
          words: message.words.map((word) => ({ ...word })),
        };
        return;
      }
    } finally {
      options?.signal?.removeEventListener('abort', cancel);
      this.listeners.delete(listener);
    }
  }

  /** Stop the worker. The provider is usable again afterwards: the next call loads a new
   * one, which is what a settings change (device, dtype, model) needs. */
  terminate(): void {
    this.detach?.();
    this.port?.terminate();
    this.detach = null;
    this.port = null;
    this.loading = null;
  }

  /** The loaded worker. Single-flight: two utterances arriving together load once. */
  private async ready(): Promise<AsrWorkerPort> {
    if (this.port === null) {
      const port = this.config.createWorker();
      this.port = port;
      this.detach = port.onMessage((message) => {
        // Iterating the Set directly is safe: a listener removing itself during dispatch
        // is defined behaviour, and nothing adds one from inside a dispatch.
        for (const listener of this.listeners) listener(message);
      });
    }
    const port = this.port;

    this.loading ??= new Promise<void>((resolve, reject) => {
      const listener = (message: AsrResponse): void => {
        if (message.type === 'ready') {
          this.listeners.delete(listener);
          resolve();
        } else if (message.type === 'error' && message.requestId === null) {
          this.listeners.delete(listener);
          // A failed load must not be cached as a failure for ever: a user who declined
          // the consent screen can grant it and try again.
          this.loading = null;
          reject(new Error(`${this.id}: ${message.message}`));
        }
      };
      this.listeners.add(listener);
      port.post({
        type: 'load',
        model: this.config.model,
        device: this.config.device ?? 'webgpu',
        dtype: this.config.dtype ?? 'fp32',
      });
    });

    await this.loading;
    return port;
  }
}
