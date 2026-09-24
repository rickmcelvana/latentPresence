import { USER_EMOTION_VA } from '@latentpresence/core';
import {
  BASE_LABELS,
  DEFAULT_SER_MODEL,
  SER_BACKEND,
  type SerBackend,
  type SerModelKey,
  type SerResponse,
  type SerWorkerPort,
} from '@latentpresence/ml-web';
import type { AffectReading, UserEmotion } from '@latentpresence/protocol';

/**
 * Voice emotion as an `AffectReading` on the `voice` channel (P3-T05), driven through a
 * worker. The model is in `packages/ml-web`, fusion is P3-T07's; this is the conversation
 * with the worker and the one judgement call — what the probabilities mean — testable in
 * node against a fake port.
 */

/** A voice reading and what it cost. */
export interface VoiceReading extends AffectReading {
  readonly inferenceMs: number;
  /** The nine class probabilities as the model gave them, for a debug overlay. */
  readonly probabilities: Readonly<Record<UserEmotion, number>>;
}

/**
 * Probabilities over `BASE_LABELS` to a reading. **`other` and `unknown` are the model
 * saying it cannot tell**, not a feeling (the base model called a neutral Kokoro sentence
 * `unknown` at 0.68 in `live:ser`), so their mass lowers the confidence and the label is
 * chosen among the seven that mean something. Valence and arousal are the probability-
 * weighted mean of those seven's positions, so a mixed reading lands between them.
 */
export function readingFromProbabilities(probabilities: readonly number[]): Omit<VoiceReading, 'inferenceMs'> {
  const named = Object.fromEntries(BASE_LABELS.map((label, k) => [label, probabilities[k] ?? 0])) as Record<UserEmotion, number>;
  const meaningful = BASE_LABELS.filter((label) => label !== 'other' && label !== 'unknown');
  const informative = meaningful.reduce((sum, label) => sum + named[label], 0);
  if (informative < MIN_INFORMATIVE) {
    return { channel: 'voice', label: 'neutral', valence: 0, arousal: 0, confidence: 0, probabilities: named };
  }
  let label: UserEmotion = 'neutral';
  let valence = 0;
  let arousal = 0;
  for (const candidate of meaningful) {
    const p = named[candidate] / informative;
    valence += p * USER_EMOTION_VA[candidate].valence;
    arousal += p * USER_EMOTION_VA[candidate].arousal;
    if (named[candidate] > named[label]) label = candidate;
  }
  return {
    channel: 'voice',
    label,
    valence,
    arousal,
    // Its own probability: the mass on `other` and `unknown` already holds it down.
    confidence: named[label],
    probabilities: named,
  };
}

/** Below this much named mass the model has mostly said it cannot tell, and is not heard. */
const MIN_INFORMATIVE = 0.5;

export interface SpeechEmotionConfig {
  readonly createWorker: () => SerWorkerPort;
  readonly model?: SerModelKey;
  readonly backend?: SerBackend;
}

interface Pending {
  resolve(reading: VoiceReading): void;
  reject(error: Error): void;
}

export class SpeechEmotionReader {
  readonly model: SerModelKey;
  readonly backend: SerBackend;
  private readonly config: SpeechEmotionConfig;
  private port: SerWorkerPort | null = null;
  private detach: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private onLoad: ((message: SerResponse) => void) | null = null;
  private nextRequestId = 0;

  constructor(config: SpeechEmotionConfig) {
    this.model = config.model ?? DEFAULT_SER_MODEL;
    this.backend = config.backend ?? SER_BACKEND[this.model];
    this.config = config;
  }

  /** Start the worker and load the model. Call it with the call, not on the first utterance. */
  load(): Promise<void> {
    this.loading ??= new Promise<void>((resolve, reject) => {
      const port = this.config.createWorker();
      this.port = port;
      this.onLoad = (message) => {
        if (message.type === 'ready') resolve();
        else if (message.type === 'error' && message.requestId === null) reject(new Error(`voice emotion: ${message.message}`));
      };
      this.detach = port.onMessage((message) => this.receive(message));
      port.post({ type: 'load', model: this.model, backend: this.backend });
    });
    return this.loading;
  }

  /** One user speech segment, 16 kHz. The buffer is transferred to the worker. */
  async read(samples: Float32Array): Promise<VoiceReading> {
    await this.load();
    const port = this.port;
    if (port === null) throw new Error('voice emotion: terminated');
    const requestId = (this.nextRequestId += 1);
    return new Promise<VoiceReading>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      port.post({ type: 'classify', requestId, samples }, [samples.buffer]);
    });
  }

  terminate(): void {
    this.detach?.();
    this.port?.terminate();
    this.port = null;
    for (const pending of this.pending.values()) pending.reject(new Error('voice emotion: terminated'));
    this.pending.clear();
  }

  private receive(message: SerResponse): void {
    if (message.type === 'ready' || (message.type === 'error' && message.requestId === null)) {
      this.onLoad?.(message);
      return;
    }
    if (message.requestId === null) return;
    const pending = this.pending.get(message.requestId);
    if (pending === undefined) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') pending.reject(new Error(`voice emotion: ${message.message}`));
    else pending.resolve({ ...readingFromProbabilities(message.probabilities), inferenceMs: message.inferenceMs });
  }
}
