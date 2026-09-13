import type {
  CancellationSignal,
  LLMProvider,
  LlmRequest,
  LlmStreamChunk,
  SpokenAudioChunk,
  TTSProvider,
  TtsRequest,
} from '@latentpresence/protocol';
import type { PlaybackEvent, PlaybackPosition, PlaybackSegment, PlaybackSink } from '../playback/sink';

/**
 * Scripted stand-ins for the reply and voice-session tests (P1-T08). Not exported from the
 * package: `packages/providers` has the real fakes, and core cannot import it.
 */

export const RATE = 24_000;
/** Every character of a sentence is 1000 frames of voiced audio, so arithmetic stays readable. */
export const FRAMES_PER_CHAR = 1000;

/** Let every promise chain in flight run out. Core has no timers to wait on. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An LLM that replays text deltas and records whether it was told to stop. */
export class ScriptedLLM implements LLMProvider {
  readonly id = 'scripted-llm';
  signal: CancellationSignal | undefined;
  yielded = 0;
  private readonly script: readonly LlmStreamChunk[];
  private readonly gate: Promise<void> | undefined;
  private readonly gateAfter: number;
  private readonly fail: Error | undefined;
  constructor(script: readonly LlmStreamChunk[], gate?: Promise<void>, gateAfter = Number.POSITIVE_INFINITY, fail?: Error) {
    this.script = script;
    this.gate = gate;
    this.gateAfter = gateAfter;
    this.fail = fail;
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async *stream(_request: LlmRequest, options?: { signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
    this.signal = options?.signal;
    for (const [i, chunk] of this.script.entries()) {
      if (i === this.gateAfter && this.gate !== undefined) await this.gate;
      if (options?.signal?.aborted === true) return;
      this.yielded += 1;
      yield chunk;
    }
    if (this.fail !== undefined) throw this.fail;
  }
}

export const text = (...parts: string[]): LlmStreamChunk[] => [
  ...parts.map((t) => ({ type: 'text-delta', text: t }) as const),
  { type: 'finish', reason: 'stop', usage: null },
];

/** Voiced audio sized by the text, delivered as one chunk plus an empty final one. */
export class ScriptedTTS implements TTSProvider {
  readonly id = 'scripted-tts';
  readonly requests: TtsRequest[] = [];
  private readonly options: { fail?: string; words?: boolean };
  constructor(options: { fail?: string; words?: boolean } = {}) {
    this.options = options;
  }
  async capabilities(): Promise<never> {
    throw new Error('unused');
  }
  async listVoices(): Promise<never[]> {
    return [];
  }
  async *synthesize(req: TtsRequest): AsyncIterable<SpokenAudioChunk> {
    this.requests.push(req);
    if (this.options.fail === req.text) throw new Error(`voice failed on "${req.text}"`);
    yield {
      samples: new Float32Array(req.text.length * FRAMES_PER_CHAR).fill(0.5),
      sampleRate: RATE,
      startMs: 0,
      isFinal: false,
      ...(this.options.words === true
        ? { words: req.text.split(' ').map((word, i) => ({ text: word, startMs: i * 10, endMs: (i + 1) * 10 })) }
        : {}),
    };
    yield { samples: new Float32Array(0), sampleRate: RATE, startMs: 0, isFinal: true };
  }
}

/** A sink the test plays by hand. */
export class ManualSink implements PlaybackSink {
  readonly segments: PlaybackSegment[] = [];
  readonly fades: number[] = [];
  /** `duck` and `unduck` calls, in order. */
  readonly gain: string[] = [];
  current: PlaybackPosition | null = null;
  private readonly listeners = new Set<(event: PlaybackEvent) => void>();
  enqueue(segment: PlaybackSegment): number {
    this.segments.push(segment);
    return this.segments.length + 99;
  }
  duck(): void {
    this.gain.push('duck');
  }
  unduck(): void {
    this.gain.push('unduck');
  }
  fadeOut(ms: number): Promise<void> {
    this.fades.push(ms);
    return Promise.resolve();
  }
  position(): PlaybackPosition | null {
    return this.current;
  }
  subscribe(listener: (event: PlaybackEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(id: number, at = 0): void {
    this.current = { id, frame: 0 };
    for (const l of this.listeners) l({ type: 'started', id, at });
  }
  end(id: number, at = 0): void {
    this.current = null;
    for (const l of this.listeners) l({ type: 'ended', id, at });
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

