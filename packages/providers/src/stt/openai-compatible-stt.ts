import type {
  AudioChunk,
  ProviderCallOptions,
  STTProvider,
  SttCapabilities,
  SttResult,
  WordTiming,
} from '@latentpresence/protocol';
import { encodeWav } from '../tts/wav';
import { isAborted } from './signal';

/**
 * `POST /audio/transcriptions` — the server half of P1-T06.
 *
 * The surface is OpenAI's and is implemented by almost everything that transcribes:
 * Groq, Deepgram's compatibility layer, faster-whisper-server, Speaches, vLLM, LM Studio.
 * Verified 2026-09-12 against the official `openai` client 2.53.0 rather than from
 * memory (SURFACE 11), which settled three things a guess would have got wrong:
 *
 * - the body is **multipart/form-data**, not JSON, and `file` is a real file part;
 * - `timestamp_granularities` is an **array serialised with brackets** —
 *   `timestamp_granularities[]` repeated per value (`_serialize_multipartform`,
 *   `array_format="brackets"`);
 * - **word timings only come back from `verbose_json`**, and only when asked for. Plain
 *   `json` returns `{ text }` and would quietly answer with no timings at all.
 *
 * Word times are in **seconds** on the wire (`TranscriptionWord.start` / `.end`) and
 * milliseconds in `WordTiming`, which is the conversion most likely to be got wrong
 * silently, so it happens in exactly one place below.
 */
export interface OpenAICompatibleSttConfig {
  /** Stable provider id, used in error messages. */
  readonly id: string;
  /** Origin plus any version prefix, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  /** The transcription model, e.g. `whisper-1` or a server's own name. */
  readonly model: string;
  readonly apiKey?: string;
  /** BCP-47 hint. Null or absent asks the server to detect. */
  readonly language?: string | null;
  /**
   * Ask for per-word times. Costs a `verbose_json` response and, on some servers, real
   * time — so it is opt-in, and `capabilities()` reports what was actually configured
   * rather than what the endpoint might in principle do.
   */
  readonly wordTimestamps?: boolean;
  /**
   * Vocabulary hint passed as `prompt`. Names, jargon and spellings the model would
   * otherwise mangle. Not a system prompt: the endpoint treats it as a transcript prefix.
   */
  readonly prompt?: string;
  /** Injected in tests. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The `verbose_json` response, narrowed to the fields this adapter reads. */
interface VerboseTranscription {
  text?: unknown;
  language?: unknown;
  words?: unknown;
}

function asWords(value: unknown): WordTiming[] {
  if (!Array.isArray(value)) return [];
  const words: WordTiming[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { word?: unknown; start?: unknown; end?: unknown };
    if (
      typeof record.word !== 'string' ||
      typeof record.start !== 'number' ||
      typeof record.end !== 'number'
    ) {
      continue;
    }
    words.push({
      text: record.word,
      startMs: Math.round(record.start * 1000),
      endMs: Math.round(record.end * 1000),
    });
  }
  return words;
}

export class OpenAICompatibleSTTProvider implements STTProvider {
  readonly id: string;
  private readonly config: OpenAICompatibleSttConfig;

  constructor(config: OpenAICompatibleSttConfig) {
    this.id = config.id;
    this.config = config;
  }

  async capabilities(): Promise<SttCapabilities> {
    return {
      // The endpoint has a streaming form, but it streams *while transcribing a finished
      // file*, not while the user is still speaking, which is not what this flag promises.
      streaming: false,
      wordTimestamps: this.config.wordTimestamps === true,
      // True only when no language was pinned: with `language` set the server is told
      // what to expect and detects nothing.
      languageDetection:
        this.config.language === undefined ||
        this.config.language === null ||
        this.config.language === '',
      runsInBrowser: false,
      // An endpoint cannot be asked what it speaks — there is no capability route on this
      // surface — so this says nothing rather than guessing from the model name.
      languages: [],
    };
  }

  /**
   * Transcribe one utterance. Yields at most one result.
   *
   * The whole utterance is collected before anything is sent, because the endpoint takes
   * a file. A call cancelled while the user is still speaking therefore costs one request
   * that never happened, which is the cheap case ADR-21 leans on.
   */
  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    options?: ProviderCallOptions,
  ): AsyncIterable<SttResult> {
    const parts: Float32Array[] = [];
    let sampleRate = 0;
    let total = 0;
    for await (const chunk of audio) {
      if (isAborted(options?.signal)) return;
      if (sampleRate === 0) sampleRate = chunk.sampleRate;
      else if (chunk.sampleRate !== sampleRate) {
        throw new Error(
          `${this.id}: sample rate changed mid-utterance: ${sampleRate} Hz then ${chunk.sampleRate} Hz`,
        );
      }
      parts.push(chunk.samples);
      total += chunk.samples.length;
    }
    if (isAborted(options?.signal)) return;
    // Nothing was said. Posting an empty file makes a server invent a hallucinated
    // sentence often enough to be worth never asking.
    if (total === 0) return;

    const samples = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
    }

    const wanted = this.config.wordTimestamps === true;
    const form = new FormData();
    form.append(
      'file',
      new Blob([encodeWav(samples, sampleRate) as BlobPart], { type: 'audio/wav' }),
      'utterance.wav',
    );
    form.append('model', this.config.model);
    form.append('response_format', wanted ? 'verbose_json' : 'json');
    // Brackets, repeated per value: what `openai` 2.53.0 puts on the wire.
    if (wanted) form.append('timestamp_granularities[]', 'word');
    const language = this.config.language;
    if (language !== undefined && language !== null && language !== '') {
      form.append('language', language);
    }
    if (this.config.prompt !== undefined) form.append('prompt', this.config.prompt);

    const headers: Record<string, string> = {};
    if (this.config.apiKey !== undefined) {
      headers['authorization'] = `Bearer ${this.config.apiKey}`;
    }
    // Content-Type is deliberately not set: `fetch` adds it with the multipart boundary,
    // and setting it by hand produces a body no server can parse.

    const doFetch = this.config.fetch ?? globalThis.fetch;
    const url = `${this.config.baseUrl.replace(/\/+$/u, '')}/audio/transcriptions`;
    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: form,
      ...(options?.signal === undefined ? {} : { signal: options.signal as AbortSignal }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // The server's own words, not ours: P1-T05 found that passing a transcription
      // endpoint's error through verbatim is what makes a bad model name diagnosable.
      throw new Error(
        `${this.id}: /audio/transcriptions returned ${response.status}${detail === '' ? '' : ` — ${detail}`}`,
      );
    }

    const body = (await response.json()) as VerboseTranscription;
    if (isAborted(options?.signal)) return;

    yield {
      text: typeof body.text === 'string' ? body.text.trim() : '',
      isFinal: true,
      // This surface reports no confidence in either response format. A fabricated 1.0
      // would tell the turn machine it can trust something nothing vouched for.
      confidence: null,
      language: typeof body.language === 'string' ? body.language : null,
      words: asWords(body.words),
    };
  }
}
