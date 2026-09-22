import type {
  LLMProvider,
  LlmRequest,
  TTSProvider,
  WordTiming,
} from '@latentpresence/protocol';
import { Cancellation } from '../cancellation';
import { SentenceChunker, TagFilter, type InlineTag, type SentenceChunkerOptions, type SpeechChunk } from '../chunker';
import type { PlaybackEvent, PlaybackSink } from '../playback/sink';
import { DEFAULT_EDGE_PADDING, spokenPrefix, trimToVoice, type EdgePadding, type SpokenSentence } from '../playback/prefix';

/**
 * One spoken answer, from the first token to the last frame (P1-T08).
 *
 * LLM text → `SentenceChunker` → `TTSProvider.synthesize` per sentence → `PlaybackSink`,
 * all under **one** cancellation, so barge-in is a single call that stops the model, the
 * synthesis in flight and the queued audio together, and says what the user heard.
 *
 * **Synthesis is sequential, in sentence order.** On a GPU server it runs ~44x faster than
 * speech (`docs/TASKS.md` D-12), so a second sentence is always ready before the first
 * finishes playing and concurrency would buy nothing but out-of-order bookkeeping.
 *
 * **Audio waits for `hold`.** A model-ended turn can still be retracted until its
 * `confirmedAt` (ADR-25). Work starts at once — the model, the synthesis — but nothing is
 * handed to the speakers before the turn is final, so a retracted turn can cost wasted
 * work and never words the character has to take back.
 */

export interface ReplyDependencies {
  readonly llm: LLMProvider;
  readonly tts: TTSProvider;
  readonly sink: PlaybackSink;
  readonly voiceId: string;
  readonly speed?: number;
  readonly chunker?: SentenceChunkerOptions;
  /**
   * Silence kept either side of each sentence's voice; null plays the synthesis untrimmed.
   * Kokoro's own padding is ~310 ms in front, which a listener hears as latency (ADR-27).
   */
  readonly padding?: EdgePadding | null;
}

export type ReplyEvent =
  /**
   * One text delta, for a transcript to stream (P1-T11), **tag-free since P1-T12**: a
   * `TagFilter` holds back any trailing text that could still become an inline tag, so a
   * tag split across deltas is never shown and then taken back. Reasoning is never a token.
   */
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'sentence'; readonly index: number; readonly text: string; readonly tags: readonly InlineTag[] }
  | { readonly type: 'audio-started'; readonly index: number; readonly at: number }
  | { readonly type: 'audio-ended'; readonly index: number; readonly at: number };

export type ReplyOutcome =
  /** Every sentence was generated and played to its end. */
  | { readonly status: 'complete'; readonly text: string }
  /** Cut off while audible. `spokenPrefix` is what the user heard; the rest was never said. */
  | { readonly status: 'interrupted'; readonly text: string; readonly spokenPrefix: string }
  /** Stopped before any of it was heard: a retracted turn, or speech during `thinking`. */
  | { readonly status: 'abandoned'; readonly text: string }
  /** The model or the voice failed. What was already queued still played. */
  | {
      readonly status: 'failed';
      readonly text: string;
      readonly spokenPrefix: string;
      readonly scope: 'llm' | 'tts';
      readonly error: string;
    };

export interface ReplyOptions {
  /** Resolves when the audio may start: the user's turn is confirmed. Default: at once. */
  readonly hold?: Promise<void>;
  readonly onEvent?: (event: ReplyEvent) => void;
}

interface Sentence extends SpokenSentence {
  readonly index: number;
  readonly id: number;
  started: boolean;
  ended: boolean;
}

function concat(parts: readonly Float32Array[]): Float32Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Reply {
  /** Settles once: when the last frame plays, or at once on `interrupt`. */
  readonly done: Promise<ReplyOutcome>;

  private readonly deps: ReplyDependencies;
  private readonly onEvent: (event: ReplyEvent) => void;
  private readonly hold: Promise<void>;
  private readonly cancellation = new Cancellation();
  private readonly chunks: SpeechChunk[] = [];
  /** Sentences handed to the sink, in order. Only these can have been heard. */
  private readonly queued: Sentence[] = [];
  private readonly byId = new Map<number, Sentence>();
  private readonly detach: () => void;
  private settle!: (outcome: ReplyOutcome) => void;
  private outcome: ReplyOutcome | null = null;
  private drained: (() => void) | null = null;

  constructor(request: LlmRequest, deps: ReplyDependencies, options: ReplyOptions = {}) {
    this.deps = deps;
    this.onEvent = options.onEvent ?? (() => {});
    this.hold = options.hold ?? Promise.resolve();
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.detach = deps.sink.subscribe((event) => this.onPlayback(event));
    void this.run(request);
  }

  /** The tag-free text generated so far, sentence by sentence. */
  get text(): string {
    return this.chunks.map((chunk) => chunk.text).join(' ');
  }

  /** Whether any of this answer has reached the speakers yet. */
  get audible(): boolean {
    return this.queued.some((sentence) => sentence.started);
  }

  /**
   * Stop everything now. If any audio was audible, fade it over `fadeMs` and settle as
   * `interrupted` with what was heard up to the fade's midpoint; otherwise drop whatever is
   * queued and settle as `abandoned`. Returns the outcome; a settled reply returns its own.
   */
  interrupt(fadeMs: number): ReplyOutcome {
    if (this.outcome !== null) return this.outcome;
    const heard = this.heardAt(fadeMs);
    this.cancellation.abort();
    if (this.queued.length > 0) void this.deps.sink.fadeOut(fadeMs);
    const outcome: ReplyOutcome =
      heard === null
        ? { status: 'abandoned', text: this.text }
        : { status: 'interrupted', text: this.text, spokenPrefix: spokenPrefix(this.queued, heard) };
    this.finish(outcome);
    return outcome;
  }

  /** Where the listener's hearing will stop if a fade of `fadeMs` starts now. */
  private heardAt(fadeMs: number): { index: number; frame: number } | null {
    const position = this.deps.sink.position();
    const current = position === null ? undefined : this.byId.get(position.id);
    if (current !== undefined && position !== null) {
      const fadeFrames = (fadeMs / 2000) * current.sampleRate;
      return { index: this.queued.indexOf(current), frame: position.frame + fadeFrames };
    }
    // Between sentences, or after the last: everything that has ended was heard in full.
    let last = -1;
    for (const [i, sentence] of this.queued.entries()) {
      if (sentence.started) last = i;
    }
    const sentence = this.queued[last];
    return sentence === undefined ? null : { index: last, frame: sentence.frames };
  }

  private async run(request: LlmRequest): Promise<void> {
    const chunker = new SentenceChunker(this.deps.chunker);
    const tagFilter = new TagFilter();
    let synthesis = Promise.resolve();
    let failure: { scope: 'llm' | 'tts'; error: string } | null = null;
    const signal = this.cancellation;

    const schedule = (chunk: SpeechChunk): void => {
      this.chunks.push(chunk);
      this.emit({ type: 'sentence', index: chunk.index, text: chunk.text, tags: chunk.tags });
      synthesis = synthesis.then(async () => {
        if (failure !== null || signal.aborted) return;
        try {
          await this.speak(chunk);
        } catch (error) {
          if (!signal.aborted) failure = { scope: 'tts', error: message(error) };
        }
      });
    };

    try {
      for await (const part of this.deps.llm.stream(request, { signal })) {
        if (signal.aborted || failure !== null) break;
        if (part.type === 'text-delta') {
          const shown = tagFilter.push(part.text);
          if (shown !== '') this.emit({ type: 'token', text: shown });
          for (const chunk of chunker.push(part.text)) schedule(chunk);
        } else if (part.type === 'finish' && part.reason === 'error') {
          failure = { scope: 'llm', error: 'the model stream ended with an error' };
        }
      }
      if (!signal.aborted && failure === null) {
        const tail = tagFilter.flush();
        if (tail !== '') this.emit({ type: 'token', text: tail });
        for (const chunk of chunker.flush()) schedule(chunk);
      }
    } catch (error) {
      if (!signal.aborted) failure = { scope: 'llm', error: message(error) };
    }

    await synthesis;
    if (signal.aborted) return;
    if (failure === null && this.chunks.length === 0) {
      // A thinking model can spend its whole budget reasoning and say nothing (P1-T02).
      failure = { scope: 'llm', error: 'the model produced no text to speak' };
    }

    await this.playedOut();
    if (this.outcome !== null) return;
    const text = this.text;
    this.finish(
      failure === null
        ? { status: 'complete', text }
        : {
            status: 'failed',
            text,
            spokenPrefix: spokenPrefix(this.queued, this.heardAt(0)),
            ...failure,
          },
    );
  }

  /** Synthesise one sentence whole, wait for the turn to be final, and queue it. */
  private async speak(chunk: SpeechChunk): Promise<void> {
    const signal = this.cancellation;
    const parts: Float32Array[] = [];
    let sampleRate = 0;
    let words: WordTiming[] | undefined;
    const request = { text: chunk.text, voiceId: this.deps.voiceId, speed: this.deps.speed ?? 1, hint: null };
    for await (const audio of this.deps.tts.synthesize(request, { signal })) {
      if (audio.samples.length > 0) {
        parts.push(audio.samples);
        sampleRate = audio.sampleRate;
      }
      if (audio.words !== undefined) {
        const offset = audio.startMs;
        words = [
          ...(words ?? []),
          ...audio.words.map((word) => ({ ...word, startMs: word.startMs + offset, endMs: word.endMs + offset })),
        ];
      }
    }
    if (signal.aborted || parts.length === 0) return;

    await Promise.race([this.hold, this.aborted()]);
    if (signal.aborted) return;

    const padding = this.deps.padding === undefined ? DEFAULT_EDGE_PADDING : this.deps.padding;
    // Measured before the sink can transfer the buffer away.
    const whole = concat(parts);
    const voiced =
      padding === null ? { samples: whole, voicedStart: 0, voicedEnd: whole.length } : trimToVoice(whole, sampleRate, padding);
    const samples = voiced.samples;
    const frames = samples.length;
    const id = this.deps.sink.enqueue({ samples, sampleRate });
    const sentence: Sentence = {
      index: chunk.index,
      id,
      text: chunk.text,
      frames,
      sampleRate,
      voicedStart: voiced.voicedStart,
      voicedEnd: voiced.voicedEnd,
      ...(words === undefined ? {} : { words }),
      started: false,
      ended: false,
    };
    this.queued.push(sentence);
    this.byId.set(id, sentence);
  }

  private onPlayback(event: PlaybackEvent): void {
    if (this.outcome !== null) return;
    const sentence = this.byId.get(event.id);
    if (sentence === undefined) return;
    if (event.type === 'started') {
      sentence.started = true;
      this.emit({ type: 'audio-started', index: sentence.index, at: event.at });
    } else {
      sentence.started = true;
      sentence.ended = true;
      this.emit({ type: 'audio-ended', index: sentence.index, at: event.at });
      if (this.queued.every((s) => s.ended)) this.drained?.();
    }
  }

  private playedOut(): Promise<void> {
    if (this.queued.every((sentence) => sentence.ended)) return Promise.resolve();
    return new Promise((resolve) => {
      this.drained = resolve;
    });
  }

  private aborted(): Promise<void> {
    const signal = this.cancellation;
    return new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve);
    });
  }

  private emit(event: ReplyEvent): void {
    if (this.outcome === null) this.onEvent(event);
  }

  private finish(outcome: ReplyOutcome): void {
    if (this.outcome !== null) return;
    this.outcome = outcome;
    this.detach();
    this.drained?.();
    this.settle(outcome);
  }
}
