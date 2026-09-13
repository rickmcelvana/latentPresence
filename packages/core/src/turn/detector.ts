import type { AudioChunk, CancellationSignal } from '@latentpresence/protocol';

/**
 * Turn detection (P1-T07): speech probabilities in, turn boundaries out.
 *
 * This is the endpointing *logic* from Spike D with every model taken out of it. Silero
 * runs somewhere else and hands over one probability per frame; Smart Turn v3 runs
 * somewhere else and answers a `TurnJudge` call. What is left — hysteresis, pre-roll,
 * candidate windows, the hangover backstop, late answers, and ADR-21's overlap with
 * recognition — is conversation logic, and it is the part most likely to be wrong, so it
 * lives here where a scripted stream of numbers can test it with no audio at all.
 *
 * **The shape of a turn.** Speech starts when a frame reaches `speechOn`. Once a pause
 * reaches `candidateMs`, the utterance so far is a *candidate*: it is handed to the judge
 * and to recognition at the same moment. A judge answer at or over `threshold` ends the
 * turn there. If nothing fires, `hangoverMs` of silence ends it anyway — Spike A's timer,
 * kept as a backstop so a turn always ends.
 *
 * **ADR-21's overlap, and when it is cancelled.** Recognition is started on the candidate
 * rather than on the confirmed turn, which is worth 40 ms against a 500 ms budget. It is
 * cancelled only when **speech resumes** — never merely because the judge said "not
 * finished". A low probability does not change the audio: if the person stays quiet and
 * the hangover closes the turn, the recognition already in flight was run on exactly the
 * words that were said, and throwing it away would repay the 180 ms the overlap saved. So
 * on the path where the model misses, the transcript is usually finished before the timer
 * even fires.
 *
 * **A model-ended turn is provisional until the hangover would have fired (ADR-25).**
 * `live/turn.ts` found Smart Turn ending sentences at inner pauses whose prefix sounds
 * finished — "The afternoon light │ came in low across the desk." — and at WebGPU speed
 * the answer lands inside the pause. If speech resumes within `hangoverMs` of where it
 * stopped, the end is retracted with `turn-resumed` and the turn carries on. That window
 * is the backstop's own definition of a pause, so it adds no constant, and it closes
 * 500 ms after speech ends — before the ~553 ms pipeline could have played an answer.
 *
 * No clock of its own, no timers, no DOM: time is whatever the frames say it is, plus an
 * injected `now()` for answers that arrive between frames.
 */

/** Silero v5's own recommendation, and the pair Spikes A and D ran with. */
export const DEFAULT_SPEECH_ON = 0.5;
/** Leave speech below this. The gap between the two is what stops chattering. */
export const DEFAULT_SPEECH_OFF = 0.35;
/**
 * ADR-21: 100 ms. With 32 ms Silero frames it fires on the fourth silent frame, 128 ms in
 * — the "128 ms of candidate silence" Spike D's 168 ms decomposes into.
 */
export const DEFAULT_CANDIDATE_MS = 100;
/** ADR-21: the backstop. With 32 ms frames it fires at 512 ms, Spike A's measured figure. */
export const DEFAULT_HANGOVER_MS = 500;
/**
 * ADR-21: 0.7. Spike D found finished sentences at 0.70–0.99 and trailed-off ones at
 * 0.005–0.03, so this is not a knife edge and is not worth tuning.
 */
export const DEFAULT_TURN_THRESHOLD = 0.7;
/** Audio kept from before speech was detected, so the first word survives. */
export const DEFAULT_PREROLL_MS = 300;
/** What Silero, Smart Turn and every recogniser here expect. */
export const TURN_SAMPLE_RATE = 16_000;

/** One VAD frame: the audio, and what the VAD thought of it. */
export interface VadFrame {
  /** Mono PCM at the detector's `sampleRate`. Kept by reference; do not reuse the buffer. */
  readonly samples: Float32Array;
  /** Silero's speech probability for this frame. */
  readonly probability: number;
  /** When the frame was captured, in ms, on the same clock as `now()`. */
  readonly at: number;
}

/**
 * The semantic endpointer: does this utterance sound finished?
 *
 * `audio` is the **whole utterance** at the detector's sample rate, pre-roll included,
 * and is the *same buffer* recognition receives. Implementations take the window they
 * need (Smart Turn keeps the last 8 s) and must neither mutate nor transfer it.
 */
export interface TurnJudge {
  judge(audio: Float32Array, signal: CancellationSignal): Promise<number>;
}

/**
 * Starts recognition on a candidate and returns whatever handle the caller wants back
 * when the turn ends — usually the transcription's promise or iterable. The signal aborts
 * when speech resumes and the candidate is stale. Same no-mutate, no-transfer rule as
 * `TurnJudge`.
 */
export type SpeculativeRecognition<R> = (audio: AudioChunk, signal: CancellationSignal) => R;

/** Level and duration of an utterance, so a bell can be told from a sentence afterwards. */
export interface UtteranceStats {
  readonly sampleCount: number;
  readonly durationMs: number;
  readonly rms: number;
  readonly peak: number;
  /** Highest Silero score in the utterance, pre-roll included. */
  readonly maxProbability: number;
}

export type TurnEndReason = 'model' | 'hangover';

export type TurnEvent<R> =
  | { readonly type: 'speech-start'; readonly turnId: number; readonly at: number }
  /**
   * A pause long enough to ask about. The turn is still open. Recognition and the judge
   * were both started before this was emitted.
   */
  | {
      readonly type: 'candidate';
      readonly turnId: number;
      readonly candidateId: number;
      readonly at: number;
      readonly speechEndAt: number;
      readonly stats: UtteranceStats;
    }
  /** A judge answer that arrived while its candidate was still the live one. */
  | {
      readonly type: 'judged';
      readonly turnId: number;
      readonly candidateId: number;
      readonly probability: number;
      readonly at: number;
    }
  /** Always immediately before `turn-end`. `at` is when speech stopped, not when it was noticed. */
  | { readonly type: 'speech-end'; readonly turnId: number; readonly at: number }
  | {
      readonly type: 'turn-end';
      readonly turnId: number;
      readonly candidateId: number;
      readonly reason: TurnEndReason;
      /** When the turn was declared over. `at - speechEndAt` is the endpointing latency. */
      readonly at: number;
      readonly speechStartAt: number;
      readonly speechEndAt: number;
      /**
       * The answer that fired, for `model`. For `hangover`, the candidate's on-time answer
       * if there was one, else null — the judge was slow, absent or failed.
       */
      readonly probability: number | null;
      /**
       * When this end can no longer be retracted. For `hangover`, now. For `model`,
       * `speechEndAt + hangoverMs`: speech resuming before then emits `turn-resumed`
       * (ADR-25). Work started on the turn before this time may have to be abandoned.
       */
      readonly confirmedAt: number;
      /** The candidate's audio: what recognition was given, without the trailing silence. */
      readonly audio: Float32Array;
      readonly stats: UtteranceStats;
      /** The recognition started on the candidate, still running or finished. Null without a recogniser. */
      readonly recognition: R | null;
    }
  /**
   * A model-ended turn taken back: speech resumed before the hangover would have closed
   * it, so by the backstop's own definition it was a pause (ADR-25). Same `turnId`, no new
   * `speech-start`; the ended candidate's recognition is cancelled, and the turn will end
   * again with audio covering the whole utterance.
   */
  | {
      readonly type: 'turn-resumed';
      readonly turnId: number;
      readonly candidateId: number;
      readonly at: number;
      /** From the end of speech to it resuming. */
      readonly pauseMs: number;
    }
  /**
   * An answer for a turn the hangover already closed. Spike D saw two, both on a cold
   * wasm inference: right, but too slow. Counted apart from a miss, and never a second
   * `turn-end`.
   */
  | {
      readonly type: 'late';
      readonly turnId: number;
      readonly candidateId: number;
      readonly probability: number;
      readonly fired: boolean;
      readonly at: number;
    }
  /** The judge threw or answered something that is not a probability. The hangover still backstops. */
  | {
      readonly type: 'judge-error';
      readonly turnId: number;
      readonly candidateId: number;
      readonly message: string;
    };

export interface TurnDetectorOptions<R> {
  /** Current time on the frames' clock, for stamping answers that arrive between frames. */
  readonly now: () => number;
  readonly judge?: TurnJudge;
  readonly recognise?: SpeculativeRecognition<R>;
  readonly sampleRate?: number;
  readonly speechOn?: number;
  readonly speechOff?: number;
  readonly candidateMs?: number;
  readonly hangoverMs?: number;
  readonly threshold?: number;
  readonly prerollMs?: number;
}

/**
 * A cancellation signal with no DOM behind it. `packages/core` compiles against ES2023
 * alone, where `AbortController` does not exist; a real `AbortSignal` satisfies the same
 * protocol interface, so providers cannot tell the difference.
 */
class Cancellation implements CancellationSignal {
  private isAborted = false;
  private readonly listeners = new Set<() => void>();

  get aborted(): boolean {
    return this.isAborted;
  }

  addEventListener(_type: 'abort', listener: () => void): void {
    if (!this.isAborted) this.listeners.add(listener);
  }

  removeEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.delete(listener);
  }

  abort(): void {
    if (this.isAborted) return;
    this.isAborted = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
  }
}

/**
 * Where a candidate stands. `superseded` means speech resumed and its answer is
 * meaningless; `hangover` means the timer closed its turn and an answer is late.
 */
type CandidateState = 'open' | 'superseded' | 'won' | 'hangover';

interface Candidate<R> {
  readonly id: number;
  readonly turnId: number;
  readonly audio: Float32Array;
  readonly stats: UtteranceStats;
  readonly speechEndAt: number;
  readonly cancellation: Cancellation;
  readonly recognition: R | null;
  state: CandidateState;
  probability: number | null;
}

interface Provisional<R> {
  readonly candidate: Candidate<R>;
  /** Every frame of the turn, still growing through the pause. */
  readonly frames: Float32Array[];
  readonly utteranceStartAt: number;
  readonly speechStartAt: number;
  readonly maxProbability: number;
}

export function utteranceStats(
  samples: Float32Array,
  sampleRate: number,
  maxProbability: number,
): UtteranceStats {
  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return {
    sampleCount: samples.length,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    rms: Math.sqrt(sumSquares / Math.max(1, samples.length)),
    peak,
    maxProbability,
  };
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export class TurnDetector<R = unknown> {
  private readonly now: () => number;
  private readonly judge: TurnJudge | null;
  private readonly recognise: SpeculativeRecognition<R> | null;
  private readonly sampleRate: number;
  private readonly speechOn: number;
  private readonly speechOff: number;
  private readonly candidateMs: number;
  private readonly hangoverMs: number;
  private readonly threshold: number;
  private readonly prerollSamples: number;
  private readonly listeners = new Set<(event: TurnEvent<R>) => void>();

  private speaking = false;
  private preroll: { frames: Float32Array[]; samples: number; firstAt: number[] } = {
    frames: [],
    samples: 0,
    firstAt: [],
  };
  private utterance: Float32Array[] = [];
  private utteranceStartAt = 0;
  private speechStartAt = 0;
  private lastSpeechAt = 0;
  private maxProbability = 0;
  private turnId = 0;
  private candidateId = 0;
  /** The live candidate for this pause, or null while speech is ongoing. */
  private candidate: Candidate<R> | null = null;
  /** The last model-ended turn, while speech resuming could still retract it. */
  private provisional: Provisional<R> | null = null;

  constructor(options: TurnDetectorOptions<R>) {
    this.now = options.now;
    this.judge = options.judge ?? null;
    this.recognise = options.recognise ?? null;
    this.sampleRate = options.sampleRate ?? TURN_SAMPLE_RATE;
    this.speechOn = options.speechOn ?? DEFAULT_SPEECH_ON;
    this.speechOff = options.speechOff ?? DEFAULT_SPEECH_OFF;
    this.candidateMs = options.candidateMs ?? DEFAULT_CANDIDATE_MS;
    this.hangoverMs = options.hangoverMs ?? DEFAULT_HANGOVER_MS;
    this.threshold = options.threshold ?? DEFAULT_TURN_THRESHOLD;
    this.prerollSamples = Math.round(((options.prerollMs ?? DEFAULT_PREROLL_MS) / 1000) * this.sampleRate);

    if (!(this.sampleRate > 0)) throw new RangeError(`sampleRate must be positive, got ${this.sampleRate}`);
    if (!(this.speechOff >= 0 && this.speechOff <= this.speechOn && this.speechOn <= 1)) {
      throw new RangeError(
        `need 0 <= speechOff <= speechOn <= 1, got speechOff ${this.speechOff}, speechOn ${this.speechOn}`,
      );
    }
    // A candidate at or after the hangover would never be offered before the turn closed,
    // and the overlap ADR-21 depends on would silently never happen.
    if (!(this.candidateMs >= 0 && this.candidateMs < this.hangoverMs)) {
      throw new RangeError(
        `need 0 <= candidateMs < hangoverMs, got candidateMs ${this.candidateMs}, hangoverMs ${this.hangoverMs}`,
      );
    }
    if (!(this.threshold > 0 && this.threshold <= 1)) {
      throw new RangeError(`threshold must be in (0, 1], got ${this.threshold}`);
    }
  }

  /** Subscribe to every event, in order. Returns an unsubscribe function. */
  subscribe(listener: (event: TurnEvent<R>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Feed one VAD frame. Frames must arrive in capture order. */
  push(frame: VadFrame): void {
    const { samples, probability, at } = frame;
    if (probability > this.maxProbability) this.maxProbability = probability;

    if (!this.speaking) {
      const provisional = this.provisional;
      if (provisional !== null) {
        provisional.frames.push(samples);
        const pauseMs = at - provisional.candidate.speechEndAt;
        if (pauseMs >= this.hangoverMs) {
          this.provisional = null;
        } else if (probability >= this.speechOn) {
          this.resumeTurn(provisional, at, pauseMs);
          return;
        }
      }
      this.keepPreroll(samples, at);
      if (probability >= this.speechOn) this.startSpeech(at);
      return;
    }

    this.utterance.push(samples);

    if (probability >= this.speechOff) {
      this.lastSpeechAt = at;
      // Speech came back: the candidate's audio is now missing words, so both its
      // recognition and its judgement are about an utterance that no longer exists.
      if (this.candidate !== null) {
        this.candidate.state = 'superseded';
        this.candidate.cancellation.abort();
        this.candidate = null;
      }
      return;
    }

    const silenceMs = at - this.lastSpeechAt;
    // One candidate per pause, not per frame: without that, a 400 ms gap at 32 ms frames
    // would ask the model a dozen times and measure a queue.
    if (this.candidate === null && silenceMs >= this.candidateMs) this.offerCandidate(at);
    if (silenceMs >= this.hangoverMs) this.endTurn('hangover', at, null);
  }

  /**
   * Drop the utterance in progress without ending a turn — the microphone stopped, or
   * the session did. Any in-flight candidate is cancelled and its answer ignored.
   */
  reset(): void {
    if (this.candidate !== null) {
      this.candidate.state = 'superseded';
      this.candidate.cancellation.abort();
    }
    // A provisional turn was already handed out; reset only stops it being retracted.
    this.provisional = null;
    this.clearUtterance();
    this.maxProbability = 0;
  }

  /**
   * Speech came back inside a model-ended turn's backstop window: the pause was a pause.
   * The same turn continues with every frame heard so far, so the next candidate — and
   * the recognition started on it — covers the whole utterance rather than its tail.
   */
  private resumeTurn(provisional: Provisional<R>, at: number, pauseMs: number): void {
    this.provisional = null;
    const { candidate } = provisional;
    candidate.state = 'superseded';
    // Its transcript is of the words before the pause; the consumer holding it from
    // `turn-end` gets a cancelled recognition rather than half a sentence.
    candidate.cancellation.abort();

    this.speaking = true;
    this.utterance = provisional.frames;
    this.utteranceStartAt = provisional.utteranceStartAt;
    this.speechStartAt = provisional.speechStartAt;
    this.lastSpeechAt = at;
    this.maxProbability = Math.max(provisional.maxProbability, this.maxProbability);
    this.preroll = { frames: [], samples: 0, firstAt: [] };
    this.emit({ type: 'turn-resumed', turnId: candidate.turnId, candidateId: candidate.id, at, pauseMs });
  }

  private emit(event: TurnEvent<R>): void {
    // Snapshot first, so a listener that unsubscribes while handling an event does not disturb this delivery.
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  private keepPreroll(samples: Float32Array, at: number): void {
    const preroll = this.preroll;
    preroll.frames.push(samples);
    preroll.firstAt.push(at);
    preroll.samples += samples.length;
    // Keep the fewest frames that still cover the pre-roll: drop the oldest only while
    // what remains without it is enough.
    while (preroll.frames.length > 1 && preroll.samples - (preroll.frames[0]?.length ?? 0) >= this.prerollSamples) {
      preroll.samples -= preroll.frames.shift()?.length ?? 0;
      preroll.firstAt.shift();
    }
  }

  private startSpeech(at: number): void {
    this.speaking = true;
    this.turnId += 1;
    this.speechStartAt = at;
    this.lastSpeechAt = at;
    // The pre-roll, which already holds this frame, becomes the head of the utterance.
    this.utterance = this.preroll.frames;
    this.utteranceStartAt = this.preroll.firstAt[0] ?? at;
    this.preroll = { frames: [], samples: 0, firstAt: [] };
    this.emit({ type: 'speech-start', turnId: this.turnId, at });
  }

  private collectUtterance(): Float32Array {
    let total = 0;
    for (const frame of this.utterance) total += frame.length;
    const joined = new Float32Array(total);
    let offset = 0;
    for (const frame of this.utterance) {
      joined.set(frame, offset);
      offset += frame.length;
    }
    return joined;
  }

  private offerCandidate(at: number): void {
    this.candidateId += 1;
    const audio = this.collectUtterance();
    const cancellation = new Cancellation();
    const stats = utteranceStats(audio, this.sampleRate, this.maxProbability);

    // Recognition and the judge are started here, in the same synchronous step and on the
    // same buffer — ADR-21's overlap. Resampling happened once, upstream of the VAD, so
    // the two paths cannot disagree about what was said.
    const recognition =
      this.recognise === null
        ? null
        : this.recognise({ samples: audio, sampleRate: this.sampleRate, startMs: this.utteranceStartAt }, cancellation);

    const candidate: Candidate<R> = {
      id: this.candidateId,
      turnId: this.turnId,
      audio,
      stats,
      speechEndAt: this.lastSpeechAt,
      cancellation,
      recognition,
      state: 'open',
      probability: null,
    };
    this.candidate = candidate;

    if (this.judge !== null) {
      let judging: Promise<number>;
      try {
        judging = this.judge.judge(audio, cancellation);
      } catch (error) {
        judging = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      judging.then(
        (probability) => this.onAnswer(candidate, probability),
        (error: unknown) => this.onJudgeError(candidate, error),
      );
    }

    this.emit({
      type: 'candidate',
      turnId: candidate.turnId,
      candidateId: candidate.id,
      at,
      speechEndAt: candidate.speechEndAt,
      stats,
    });
  }

  private onAnswer(candidate: Candidate<R>, probability: number): void {
    if (!isProbability(probability)) {
      this.onJudgeError(candidate, new Error(`judge answered ${String(probability)}, which is not a probability`));
      return;
    }
    const at = this.now();

    if (candidate.state === 'hangover') {
      this.emit({
        type: 'late',
        turnId: candidate.turnId,
        candidateId: candidate.id,
        probability,
        fired: probability >= this.threshold,
        at,
      });
      return;
    }
    // Superseded: speech resumed after this window was cut, so the answer is about words
    // that were not the end of anything. `won` cannot be answered twice.
    if (candidate.state !== 'open') return;

    candidate.probability = probability;
    this.emit({ type: 'judged', turnId: candidate.turnId, candidateId: candidate.id, probability, at });
    // A listener may have reset the detector while handling `judged`.
    if (probability >= this.threshold && this.candidate === candidate) this.endTurn('model', at, probability);
  }

  private onJudgeError(candidate: Candidate<R>, error: unknown): void {
    // A cancelled judgement rejecting is the judge doing what it was asked.
    if (candidate.state === 'superseded') return;
    this.emit({
      type: 'judge-error',
      turnId: candidate.turnId,
      candidateId: candidate.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private endTurn(reason: TurnEndReason, at: number, probability: number | null): void {
    const candidate = this.candidate;
    // `push` offers a candidate before it can reach the hangover, and the model only fires
    // on a live candidate, so this is unreachable; it is here so a future edit that breaks
    // that ordering fails loudly instead of ending a turn with no audio.
    if (candidate === null) throw new Error('turn ended with no candidate');

    candidate.state = reason === 'model' ? 'won' : 'hangover';
    const turnId = this.turnId;
    const speechStartAt = this.speechStartAt;
    if (reason === 'model') {
      this.provisional = {
        candidate,
        frames: this.utterance,
        utteranceStartAt: this.utteranceStartAt,
        speechStartAt,
        maxProbability: this.maxProbability,
      };
    }
    this.clearUtterance();
    this.maxProbability = 0;

    this.emit({ type: 'speech-end', turnId, at: candidate.speechEndAt });
    this.emit({
      type: 'turn-end',
      turnId,
      candidateId: candidate.id,
      reason,
      at,
      speechStartAt,
      speechEndAt: candidate.speechEndAt,
      probability: probability ?? candidate.probability,
      confirmedAt: reason === 'model' ? candidate.speechEndAt + this.hangoverMs : at,
      audio: candidate.audio,
      stats: candidate.stats,
      recognition: candidate.recognition,
    });
  }

  private clearUtterance(): void {
    this.speaking = false;
    this.utterance = [];
    this.candidate = null;
    this.preroll = { frames: [], samples: 0, firstAt: [] };
  }
}
