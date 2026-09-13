import type { ModelDescriptor } from '@latentpresence/protocol';

/**
 * The contract between the recognition worker and whatever drives it (P1-T06).
 *
 * Same split as `../kokoro`: the worker is a transformers.js wrapper and ADR-11 puts
 * those in `packages/ml-web`, while the providers in `packages/providers` import only
 * these types. That is what keeps `MoonshineBrowserSTTProvider` testable in node against
 * a four-line fake port.
 */

/** Precisions transformers.js accepts for an ASR graph, narrowed to ones these repos ship. */
export type AsrDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

/** The two devices a browser worker can reach. `cpu` is the node backend. */
export type AsrDevice = 'webgpu' | 'wasm';

/** Every ASR model this project offers. */
export type AsrModelKey = 'moonshine-tiny' | 'moonshine-base' | 'whisper-base' | 'whisper-tiny-en';

/**
 * What every recognition model here expects, in Hz.
 *
 * **transformers.js does not resample a `Float32Array`.** `prepareAudios` in
 * `src/pipelines.js` passes one straight through and uses its `sampling_rate` argument
 * only for URLs it has to decode. Handing over unconverted audio is not an error; it is a
 * wrong answer with no warning, and how wrong depends on how far off the rate is. Measured
 * 2026-09-12 on one sentence: at 24 kHz read as 16 kHz (1.5x) both models were still
 * perfect, and at **48 kHz read as 16 kHz (3.0x) — what a browser microphone gives you —
 * Moonshine returned nothing and Whisper returned a fluent, confident, entirely invented
 * sentence.** `resample()` in this folder exists for that reason.
 */
export const ASR_SAMPLE_RATE = 16_000;

/**
 * Everything a model needs downloaded, by precision, in bytes.
 *
 * **Measured, not read off a listing.** A Hugging Face repo holds every quantisation and
 * several tokenizer formats, and transformers.js fetches two graphs — `encoder_model` and
 * `decoder_model_merged`, from `constructSessions` in `src/models.js` — plus only some of
 * the JSON. Summing the listing's JSON overstated `whisper-base` by 1.63 MB, because
 * `vocab.json`, `merges.txt`, `normalizer.json` and `added_tokens.json` are never fetched
 * when a `tokenizer.json` is present. Both totals below were confirmed by downloading into
 * an empty cache (`live/asr-download.ts`, 2026-09-12, `docs/SURFACE.md`).
 *
 * The non-graph bytes are the same at every precision, so the rows that were not
 * downloaded are that measured constant plus graph sizes from the blob listing.
 *
 * **Why the Whisper entries name `_timestamped` repos.** The plain `onnx-community/whisper-*`
 * exports throw on any request for word timings — *"Model outputs must contain cross
 * attentions to extract timestamps. This is most likely because the model was not exported
 * with `output_attentions=True`"* — so a provider advertising `wordTimestamps: true` against
 * one of them would fail on every utterance. Found by running it (`live/stt.ts`,
 * 2026-09-12), not by reading about it. The `_timestamped` exports carry the attention
 * outputs and are within 23 KB of the same size, so there is nothing to trade off.
 */
interface AsrModelSpec {
  readonly modelId: string;
  readonly label: string;
  readonly licence: string;
  /** Bytes per precision. A precision absent here cannot be consented to, so is refused. */
  readonly bytes: Partial<Record<AsrDtype, number>>;
  /** BCP-47 tags the model is trained for. One entry means it cannot detect a language. */
  readonly languages: readonly string[];
  /** Whether the pipeline can return per-word times for this architecture. */
  readonly wordTimestamps: boolean;
}

/**
 * The non-graph bytes, per model. The fetched set is exactly `config.json`,
 * `generation_config.json`, `preprocessor_config.json`, `tokenizer.json` and
 * `tokenizer_config.json` — established by downloading two of these models into an empty
 * cache and listing what landed. Summing those five from the blob listing reproduces both
 * measured totals to the byte, which is what makes the other two derived rather than
 * guessed. Note `special_tokens_map.json` is present in the repos and is *not* fetched.
 */
const MOONSHINE_TINY_CONFIG_BYTES = 3_898_685; // measured
const MOONSHINE_BASE_CONFIG_BYTES = 3_898_686;
const WHISPER_BASE_CONFIG_BYTES = 2_769_562; // measured
const WHISPER_TINY_EN_CONFIG_BYTES = 2_692_523;

export const ASR_MODELS: Readonly<Record<AsrModelKey, AsrModelSpec>> = {
  'moonshine-tiny': {
    modelId: 'onnx-community/moonshine-tiny-ONNX',
    label: 'Moonshine tiny (speech to text)',
    licence: 'MIT',
    bytes: {
      fp32: 30_882_331 + 78_227_550 + MOONSHINE_TINY_CONFIG_BYTES,
      fp16: 15_520_007 + 76_250_574 + MOONSHINE_TINY_CONFIG_BYTES,
      q8: 7_937_661 + 20_243_286 + MOONSHINE_TINY_CONFIG_BYTES, // 32_079_632, measured
      q4: 10_732_274 + 44_650_684 + MOONSHINE_TINY_CONFIG_BYTES,
      q4f16: 6_940_638 + 49_083_577 + MOONSHINE_TINY_CONFIG_BYTES,
    },
    // Moonshine is English-only and `_call_moonshine` never reports a language.
    languages: ['en'],
    wordTimestamps: false,
  },
  'moonshine-base': {
    modelId: 'onnx-community/moonshine-base-ONNX',
    label: 'Moonshine base (speech to text)',
    licence: 'MIT',
    bytes: {
      fp32: 80_818_781 + 166_211_345 + MOONSHINE_BASE_CONFIG_BYTES,
      fp16: 40_512_679 + 160_691_155 + MOONSHINE_BASE_CONFIG_BYTES,
      q8: 20_513_063 + 42_498_870 + MOONSHINE_BASE_CONFIG_BYTES,
      q4: 24_755_792 + 72_781_828 + MOONSHINE_BASE_CONFIG_BYTES,
      q4f16: 16_638_074 + 85_089_526 + MOONSHINE_BASE_CONFIG_BYTES,
    },
    languages: ['en'],
    wordTimestamps: false,
  },
  'whisper-base': {
    // The `_timestamped` export, not the plain one. See the note below: the plain export
    // cannot produce word timings at all, and this one costs 23 KB less.
    modelId: 'onnx-community/whisper-base_timestamped',
    label: 'Whisper base (speech to text, multilingual)',
    licence: 'Apache-2.0',
    bytes: {
      fp32: 82_451_730 + 208_686_733 + WHISPER_BASE_CONFIG_BYTES,
      fp16: 41_270_731 + 104_701_989 + WHISPER_BASE_CONFIG_BYTES,
      q8: 23_159_167 + 53_712_708 + WHISPER_BASE_CONFIG_BYTES,
      q4: 18_771_046 + 123_738_327 + WHISPER_BASE_CONFIG_BYTES,
      // The repo has no `_q4f16` pair for this model, so it is absent rather than guessed.
    },
    // Whisper's multilingual checkpoints detect the language themselves; the full tag
    // list is the model's ninety-nine and is not enumerated here. Empty means "did not
    // say", per `SttCapabilities.languages`, and detection is reported separately.
    languages: [],
    wordTimestamps: true,
  },
  'whisper-tiny-en': {
    modelId: 'onnx-community/whisper-tiny.en_timestamped',
    label: 'Whisper tiny (speech to text, English)',
    licence: 'Apache-2.0',
    bytes: {
      fp32: 32_894_434 + 118_662_672 + WHISPER_TINY_EN_CONFIG_BYTES,
      fp16: 16_477_869 + 59_573_666 + WHISPER_TINY_EN_CONFIG_BYTES,
      q8: 10_097_112 + 30_729_881 + WHISPER_TINY_EN_CONFIG_BYTES,
      q4: 9_019_892 + 86_803_045 + WHISPER_TINY_EN_CONFIG_BYTES,
    },
    languages: ['en'],
    wordTimestamps: true,
  },
};

/**
 * Precisions that must never be offered on WebGPU.
 *
 * ADR-20 records what happens when they are: transformers.js's WebGPU q8 path returned
 * **the same fluent sentence for every utterance, with no error at all**. A wrong answer
 * that looks like a right one is the worst failure this pipeline can have, because
 * nothing downstream — not the transcript, not memory, not the model — can tell.
 *
 * `int8` is the same graph under another suffix and is excluded from `AsrDtype` entirely.
 */
const UNSAFE_ON_WEBGPU: readonly AsrDtype[] = ['q8', 'q4', 'q4f16'];

/** True when this precision may be loaded on this device. */
export function isSupportedCombination(device: AsrDevice, dtype: AsrDtype): boolean {
  return device !== 'webgpu' || !UNSAFE_ON_WEBGPU.includes(dtype);
}

/**
 * Why a combination was refused, in words a settings screen can show.
 * Returns null when it is allowed.
 */
export function combinationBlocker(device: AsrDevice, dtype: AsrDtype): string | null {
  if (isSupportedCombination(device, dtype)) return null;
  return `${dtype} is not offered on WebGPU: the quantised graph transcribes every utterance as the same sentence, without reporting an error (ADR-20).`;
}

/** True for a precision this model has a recorded size for, and can therefore consent to. */
export function hasRecordedAsrSize(model: AsrModelKey, dtype: AsrDtype): boolean {
  return ASR_MODELS[model].bytes[dtype] !== undefined;
}

/**
 * What the consent screen (P1-T13) shows before a recognition model is fetched.
 *
 * Throws rather than guessing when the precision has no measured size: ADR-09's promise
 * is that the number shown is the number downloaded, and an approximate one breaks it
 * more quietly than no number at all.
 */
/**
 * How many tokens Moonshine may generate for this much audio.
 *
 * The Moonshine paper's rule is six output tokens per second of audio, a guard against
 * repeated output. transformers.js 3.8.1 implements it as `Math.floor(seconds) * 6`
 * (`_call_moonshine`, `src/pipelines.js`), and **flooring the seconds first truncates the
 * utterances a conversation is made of**: anything from 1.0 to 1.99 s gets six tokens, and
 * anything under a second gets none. Measured 2026-09-13 on fifteen Kokoro sentences, each
 * followed by the 128 ms of silence a candidate window carries (`docs/SURFACE.md`): the
 * library budget cut nine of fifteen — "Could you turn the music down a little?" came
 * back as "Could you turn the music down", and "Okay, sure." as "Okay". This rule was exact
 * on fourteen; the fifteenth misheard one word identically at every budget tried.
 *
 * Nothing larger is taken. `ceil(s * 8)` and `ceil(s * 6) + 2` changed no transcript, and
 * P1-T06 found that a generous floor makes Moonshine repeat itself ("Yes, yes, yes."). At
 * this budget a 0.61 s "Yes." gets four tokens and comes back as "Yes.".
 */
export function moonshineTokenBudget(sampleCount: number, sampleRate: number): number {
  return Math.ceil((sampleCount / sampleRate) * 6);
}

export function asrModel(model: AsrModelKey, dtype: AsrDtype): ModelDescriptor {
  const spec = ASR_MODELS[model];
  const sizeBytes = spec.bytes[dtype];
  if (sizeBytes === undefined) {
    throw new Error(`no recorded download size for ${spec.modelId} at ${dtype}`);
  }
  return {
    id: `${spec.modelId}:${dtype}`,
    label: `${spec.label}, ${dtype}`,
    sizeBytes,
    licence: spec.licence,
    sourceUrl: `https://huggingface.co/${spec.modelId}`,
  };
}

/** Main thread to worker. */
export type AsrRequest =
  | {
      readonly type: 'load';
      readonly model: AsrModelKey;
      readonly device: AsrDevice;
      readonly dtype: AsrDtype;
    }
  | {
      readonly type: 'transcribe';
      readonly requestId: number;
      /** Mono PCM at `sampleRate`. The worker resamples to `ASR_SAMPLE_RATE`. */
      readonly samples: Float32Array;
      readonly sampleRate: number;
      /** BCP-47 hint for a multilingual model. Null asks it to detect. */
      readonly language: string | null;
    }
  /**
   * Abandon a transcription. Unlike Kokoro's, this one really does stop mid-work:
   * `InterruptableStoppingCriteria` is checked between generated tokens, so a cancel
   * lands within a token rather than at the end of the utterance. ADR-21 needs this —
   * recognition starts on a candidate window that may turn out not to be a turn at all,
   * and the discarded work is the common case, not the exception.
   */
  | { readonly type: 'cancel'; readonly requestId: number };

/** Worker to main thread. */
export type AsrResponse =
  | { readonly type: 'ready'; readonly loadMs: number }
  | { readonly type: 'progress'; readonly file: string; readonly percent: number }
  | {
      readonly type: 'result';
      readonly requestId: number;
      readonly text: string;
      /** Seconds from the start of the submitted audio. Empty when unsupported. */
      readonly words: readonly { text: string; startMs: number; endMs: number }[];
      readonly language: string | null;
    }
  /** Acknowledges a `cancel`. No `result` will follow for that id. */
  | { readonly type: 'cancelled'; readonly requestId: number }
  /** `requestId` is null for a failure that belongs to the worker rather than a request. */
  | { readonly type: 'error'; readonly requestId: number | null; readonly message: string };

/**
 * The worker as its driver sees it. Same reasoning as `KokoroWorkerPort`: not `Worker`'s
 * `EventTarget` shape, because a hand-written listener is not assignable to
 * `EventListener` under `strictFunctionTypes` and every fake would pay for it.
 */
export interface AsrWorkerPort {
  post(message: AsrRequest, transfer?: readonly Transferable[]): void;
  /** Attach a message sink. The returned function detaches it. */
  onMessage(listener: (message: AsrResponse) => void): () => void;
  terminate(): void;
}
