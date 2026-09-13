import type {
  AudioChunk,
  ProviderCallOptions,
  STTProvider,
  SttCapabilities,
  SttResult,
} from '@latentpresence/protocol';
import { isAborted } from './signal';

/** What `FakeSTTProvider` reports when nothing overrides it: the most capable shape, so a
 * consumer written against it is exercised on every branch a real one can take. */
const DEFAULT_CAPABILITIES: SttCapabilities = {
  streaming: true,
  wordTimestamps: true,
  languageDetection: true,
  runsInBrowser: true,
  languages: ['en'],
};

export interface FakeSTTProviderOptions {
  readonly capabilities?: Partial<SttCapabilities>;
  /**
   * What to "hear". Emitted as partials word by word and then once as final, so a
   * consumer that mishandles replacement shows it.
   */
  readonly transcript?: string;
  /** Replay these instead of deriving them from `transcript`. */
  readonly script?: readonly SttResult[];
  /** Reported on every result. Null is the honest default for a model that cannot say. */
  readonly confidence?: number | null;
  readonly language?: string | null;
}

/**
 * An `STTProvider` that needs no model and no network (P1-T06).
 *
 * Every provider ships one (CLAUDE.md). This one carries the two behaviours the real
 * providers make hardest to exercise:
 *
 * - **partial results**, which neither browser model produces — Moonshine and Whisper are
 *   both whole-utterance — so without a fake nothing downstream would ever see the
 *   replacement path that `SttResult.isFinal` exists for;
 * - **cancellation mid-transcription**, which ADR-21 makes the *common* case rather than
 *   an error path, and which is otherwise only reachable by racing a real model.
 *
 * It also records what it consumed, so a test can assert the audio actually reached it
 * — the resampling bugs in this area are all silent, and "did the samples arrive, at what
 * rate" is the question that catches them.
 */
export class FakeSTTProvider implements STTProvider {
  readonly id: string;
  /** Every utterance handed to `transcribe`, joined, in order. */
  readonly heard: { samples: Float32Array; sampleRate: number }[] = [];
  /** Set when a call was cancelled, so a test can tell "no result" from "never ran". */
  cancelledCalls = 0;

  private readonly options: FakeSTTProviderOptions;

  constructor(id = 'fake-stt', options: FakeSTTProviderOptions = {}) {
    this.id = id;
    this.options = options;
  }

  async capabilities(): Promise<SttCapabilities> {
    return { ...DEFAULT_CAPABILITIES, ...this.options.capabilities };
  }

  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    options?: ProviderCallOptions,
  ): AsyncIterable<SttResult> {
    const parts: Float32Array[] = [];
    let sampleRate = 0;
    let total = 0;
    for await (const chunk of audio) {
      if (sampleRate === 0) sampleRate = chunk.sampleRate;
      parts.push(chunk.samples);
      total += chunk.samples.length;
    }
    const samples = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
    }
    this.heard.push({ samples, sampleRate });

    if (isAborted(options?.signal)) {
      this.cancelledCalls += 1;
      return;
    }

    for (const result of this.results()) {
      // Checked between results rather than only at the start: the point of this fake is
      // to let a consumer be cancelled *during* a transcription, which is the path
      // ADR-21 takes on every candidate window that turns out not to be a turn.
      if (isAborted(options?.signal)) {
        this.cancelledCalls += 1;
        return;
      }
      yield result;
    }
  }

  /** Partials word by word, then the whole thing as final. */
  private results(): SttResult[] {
    if (this.options.script !== undefined) return [...this.options.script];

    const transcript = this.options.transcript ?? 'the quick brown fox';
    const confidence = this.options.confidence ?? null;
    const language = this.options.language ?? 'en';
    const words = transcript.split(/\s+/u).filter((word) => word !== '');

    // 300 ms a word, which is ordinary speech and makes the timings add up to something
    // a consumer can sanity-check rather than a constant it has to special-case.
    const timed = words.map((word, index) => ({
      text: word,
      startMs: index * 300,
      endMs: (index + 1) * 300,
    }));

    const results: SttResult[] = words.map((_, index) => ({
      text: words.slice(0, index + 1).join(' '),
      isFinal: false,
      confidence,
      language,
      words: timed.slice(0, index + 1),
    }));
    results.push({ text: transcript, isFinal: true, confidence, language, words: timed });
    return results;
  }
}
