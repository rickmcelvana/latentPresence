import type {
  CancellationSignal,
  SpokenAudioChunk,
  TTSProvider,
  TtsCapabilities,
  TtsRequest,
  TtsVoice,
} from '@latentpresence/protocol';

/** What `FakeTTSProvider` reports when nothing overrides it: the most capable shape, so a
 * consumer written against it is exercised on every branch the real ones can take. */
const DEFAULT_CAPABILITIES: TtsCapabilities = {
  streaming: true,
  wordTimestamps: true,
  emotionHints: true,
  styleTags: false,
  runsInBrowser: true,
  sampleRate: 24_000,
};

const DEFAULT_VOICES: readonly TtsVoice[] = [
  { id: 'fake-neutral', label: 'Fake (neutral)', language: 'en-us', gender: 'neutral' },
  { id: 'fake-female', label: 'Fake (female)', language: 'en-gb', gender: 'female' },
];

export interface FakeTTSProviderOptions {
  readonly capabilities?: Partial<TtsCapabilities>;
  readonly voices?: readonly TtsVoice[];
  /** Replay these instead of generating silence. Use it to script a specific shape. */
  readonly script?: readonly SpokenAudioChunk[];
  /** How long a character of text is worth, when generating. */
  readonly msPerChar?: number;
  /** How many chunks a generated utterance is split into. */
  readonly chunks?: number;
}

/**
 * A `TTSProvider` that needs no model and no network (P1-T05).
 *
 * Every provider ships one (CLAUDE.md), and this one carries more than the LLM fake: it
 * produces *plausibly shaped* audio — the right number of samples at the right rate, with
 * word timings that add up — because the things downstream of TTS are an audio queue
 * (P1-T08) and a viseme scheduler (P2), and both are arithmetic over durations. A script
 * of two empty chunks would let either of them be wrong and still pass.
 *
 * The samples are silence. Nothing downstream listens, and a tone would make a failing
 * test sound like a working one.
 */
export class FakeTTSProvider implements TTSProvider {
  readonly id: string;
  /** Every request this provider was given, in order. */
  readonly requests: TtsRequest[] = [];
  private readonly options: FakeTTSProviderOptions;

  constructor(id: string, options: FakeTTSProviderOptions = {}) {
    this.id = id;
    this.options = options;
  }

  async capabilities(): Promise<TtsCapabilities> {
    return { ...DEFAULT_CAPABILITIES, ...this.options.capabilities };
  }

  async listVoices(): Promise<TtsVoice[]> {
    return [...(this.options.voices ?? DEFAULT_VOICES)];
  }

  async *synthesize(
    request: TtsRequest,
    options?: { signal?: CancellationSignal },
  ): AsyncIterable<SpokenAudioChunk> {
    this.requests.push(request);
    const script = this.options.script ?? this.generate(request);
    for (const chunk of script) {
      // Barge-in stops the tap here, as it does in the real providers.
      if (options?.signal?.aborted === true) {
        yield { ...chunk, isFinal: true };
        return;
      }
      yield chunk;
    }
  }

  /** Silence proportional to the text, split into `chunks`, with one word timing per word
   * spread evenly across the utterance. */
  private generate(request: TtsRequest): readonly SpokenAudioChunk[] {
    const rate = this.options.capabilities?.sampleRate ?? DEFAULT_CAPABILITIES.sampleRate;
    const msPerChar = this.options.msPerChar ?? 60;
    const count = Math.max(1, this.options.chunks ?? 1);
    const totalMs = Math.max(1, Math.round((request.text.length * msPerChar) / request.speed));
    const totalSamples = Math.round((totalMs * rate) / 1000);

    const words = request.text.split(/\s+/u).filter((word) => word !== '');
    const perWord = words.length === 0 ? 0 : totalMs / words.length;

    const chunks: SpokenAudioChunk[] = [];
    let produced = 0;
    for (let index = 0; index < count; index += 1) {
      const end = Math.round((totalSamples * (index + 1)) / count);
      const startMs = (produced / rate) * 1000;
      const isFinal = index === count - 1;
      chunks.push({
        samples: new Float32Array(end - produced),
        sampleRate: rate,
        startMs,
        // All the timings ride on the last chunk, which is the honest place for them: a
        // backend that has them only knows them once the utterance is finished.
        ...(isFinal && words.length > 0
          ? {
              words: words.map((text, wordIndex) => ({
                text,
                startMs: Math.round(wordIndex * perWord),
                endMs: Math.round((wordIndex + 1) * perWord),
              })),
            }
          : {}),
        isFinal,
      });
      produced = end;
    }
    return chunks;
  }
}
