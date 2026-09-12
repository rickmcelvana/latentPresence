import type {
  CancellationSignal,
  EmotionHint,
  SpokenAudioChunk,
  TTSProvider,
  TtsCapabilities,
  TtsRequest,
  TtsVoice,
} from '@latentpresence/protocol';
import type { HttpFetch } from '../llm/discovery';
import { normaliseBaseUrl } from '../llm/discovery';
import { decodePcm16, decodeWav, type DecodedAudio } from './wav';

/**
 * Text to speech over the OpenAI `/audio/speech` surface (P1-T05).
 *
 * One adapter for OpenAI itself and for every server that copies it — Kokoro-FastAPI,
 * openedai-speech, LocalAI. The request body is verified against the OpenAI OpenAPI
 * schema and against Kokoro-FastAPI's own request model (`docs/SURFACE.md`, 2026-09-12);
 * the two agree on `model`, `input`, `voice`, `response_format` and `speed`, which is all
 * this sends.
 *
 * **It does not stream, and that is a design decision rather than a gap (ADR-24).** The
 * caller hands it one sentence, because P1-T04's chunker has already split the token
 * stream; the latency that matters is therefore per sentence and is already won. SSE
 * (`stream_format: 'sse'`) exists on OpenAI and would buy a fraction of one sentence at
 * the cost of base64 framing and partial-container decoding. `capabilities().streaming`
 * says `false` so nothing downstream is misled.
 */
export interface OpenAICompatibleTtsConfig {
  /** Stable provider id. */
  readonly id: string;
  /** Trailing-slash tolerant `/v1` base URL, as for the LLM adapter. */
  readonly baseUrl: string;
  /** `tts-1`, `gpt-4o-mini-tts`, `kokoro` — whatever the endpoint calls its model. */
  readonly model: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  /** Injected transport for tests; defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
  /**
   * `wav` by default: it states its own sample rate, which headerless `pcm` does not.
   * Choose `pcm` only with a server that documents its rate, and set `sampleRate` too.
   */
  readonly responseFormat?: 'wav' | 'pcm';
  /**
   * What `capabilities()` promises, and the rate `pcm` bytes are read at. 24 kHz is
   * OpenAI's and Kokoro-FastAPI's. With `wav` the header wins for the audio itself — this
   * is only what can be promised before a response exists.
   */
  readonly sampleRate?: number;
  /**
   * How an `EmotionHint` reaches the backend. `instructions` is a real OpenAI field and
   * is ignored by `tts-1`/`tts-1-hd`; it is off by default because a self-hosted server
   * may reject a body field it does not know.
   */
  readonly hintStyle?: 'none' | 'instructions';
  /** Voices to report when the endpoint has no listing. OpenAI has none: its spec's only
   * `/audio/voices` is a POST that creates a custom voice. */
  readonly voices?: readonly TtsVoice[];
}

const DEFAULT_SAMPLE_RATE = 24_000;

/** `speed`'s documented range. Outside it the request is rejected, so clamp rather than
 * let a slider send 5. */
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;

function band(value: number, low: string, middle: string, high: string): string {
  if (value < 1 / 3) return low;
  if (value < 2 / 3) return middle;
  return high;
}

/**
 * An `EmotionHint` as text for the `instructions` field.
 *
 * Text, because that is what the field takes — there is no structured emotion parameter
 * on this surface for either vendor. Labelled rather than written as a sentence: the
 * twelve `CharacterEmotion`s are nouns of different shapes and "speak strongly
 * embarrassment" is the kind of phrasing that makes a model hedge. Short, too —
 * `instructions` shares a 4096-character budget with the text itself.
 */
export function describeHint(hint: EmotionHint): string {
  const intensity = band(hint.intensity, 'slight', 'clear', 'strong');
  const energy = band(hint.energy, 'low', 'moderate', 'high');
  return `Tone: ${hint.label}, ${intensity}. Energy: ${energy}.`;
}

/** One entry of a `GET /audio/voices` listing. Kokoro-FastAPI returns objects by default
 * and plain strings under `?legacy=true`, so both are accepted. */
type VoiceListEntry = string | { id?: unknown; name?: unknown };

function toVoice(entry: VoiceListEntry): TtsVoice | null {
  if (typeof entry === 'string') {
    return entry === '' ? null : { id: entry, label: entry, language: null, gender: 'unknown' };
  }
  if (typeof entry !== 'object' || entry === null) return null;
  const { id, name } = entry;
  if (typeof id !== 'string' || id === '') return null;
  return {
    id,
    label: typeof name === 'string' && name !== '' ? name : id,
    // Neither vendor states a language on this endpoint, and the schema would rather
    // have null than a tag inferred from a voice name.
    language: null,
    gender: 'unknown',
  };
}

export class OpenAICompatibleTTSProvider implements TTSProvider {
  readonly id: string;
  private readonly config: OpenAICompatibleTtsConfig;
  private readonly baseUrl: string;

  constructor(config: OpenAICompatibleTtsConfig) {
    this.id = config.id;
    this.config = config;
    this.baseUrl = normaliseBaseUrl(config.baseUrl);
  }

  async capabilities(): Promise<TtsCapabilities> {
    return {
      streaming: false,
      // Neither surface returns word timings. P2 schedules visemes from wawa-lipsync
      // analysis instead, which is what `capabilities.ts` already anticipates.
      wordTimestamps: false,
      emotionHints: this.config.hintStyle === 'instructions',
      styleTags: false,
      runsInBrowser: false,
      sampleRate: this.config.sampleRate ?? DEFAULT_SAMPLE_RATE,
    };
  }

  /**
   * Voices the endpoint offers. `GET /audio/voices` is a Kokoro-FastAPI extension rather
   * than part of OpenAI's surface, so a 404 is the normal answer and falls back to the
   * configured list instead of failing.
   */
  async listVoices(): Promise<TtsVoice[]> {
    const configured = [...(this.config.voices ?? [])];
    const fetchFn = this.config.fetch ?? fetch;
    try {
      const response = await fetchFn(`${this.baseUrl}/audio/voices`, {
        headers: this.requestHeaders(false),
      });
      if (!response.ok) return configured;
      const body = (await response.json()) as { voices?: unknown };
      if (!Array.isArray(body.voices)) return configured;
      const voices = (body.voices as VoiceListEntry[])
        .map((entry) => toVoice(entry))
        .filter((voice): voice is TtsVoice => voice !== null);
      return voices.length > 0 ? voices : configured;
    } catch {
      // A listing that is not there is not an error the user needs to see; a synthesis
      // that fails is, and that one throws.
      return configured;
    }
  }

  /**
   * One request, one chunk. `startMs` is 0 because the request is one sentence and the
   * queue that concatenates sentences (P1-T08) owns the running clock.
   */
  async *synthesize(
    request: TtsRequest,
    options?: { signal?: CancellationSignal },
  ): AsyncIterable<SpokenAudioChunk> {
    const fetchFn = this.config.fetch ?? fetch;
    const format = this.config.responseFormat ?? 'wav';

    const body: Record<string, unknown> = {
      model: this.config.model,
      input: request.text,
      voice: request.voiceId,
      response_format: format,
      speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, request.speed)),
    };
    if (this.config.hintStyle === 'instructions' && request.hint !== null) {
      body['instructions'] = describeHint(request.hint);
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options?.signal?.addEventListener('abort', onAbort);

    let decoded: DecodedAudio;
    try {
      const response = await fetchFn(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: this.requestHeaders(true),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `${this.id}: /audio/speech returned ${response.status}${detail === '' ? '' : ` — ${detail}`}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      decoded =
        format === 'wav'
          ? decodeWav(bytes)
          : decodePcm16(bytes, this.config.sampleRate ?? DEFAULT_SAMPLE_RATE);
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
    }

    yield {
      samples: decoded.samples,
      // The header, not the configuration: a server that answers at 22.05 kHz should be
      // played at 22.05 kHz rather than at what we hoped for.
      sampleRate: decoded.sampleRate,
      startMs: 0,
      isFinal: true,
    };
  }

  private requestHeaders(json: boolean): Record<string, string> {
    const headers: Record<string, string> = { ...this.config.headers };
    if (json) headers['content-type'] = 'application/json';
    if (this.config.apiKey !== undefined) {
      headers['authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }
}
