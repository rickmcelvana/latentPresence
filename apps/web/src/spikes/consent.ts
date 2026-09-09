/**
 * What Spike A would download, and what the user is shown before it does.
 *
 * ADR-09 is a hard rule: nothing downloads without a consent screen showing size,
 * licence and source. The spike is the first thing in this repo to fetch a weight, so
 * this is where the pattern is set for P1-T13.
 *
 * Sizes and licences are from the Hugging Face API on 2026-09-08 and are recorded in
 * `docs/SURFACE.md`. They are written down rather than fetched so the screen can be
 * shown before any network call — asking the network how big a download is, in order to
 * decide whether to make it, gives the game away.
 */

/**
 * The precisions the spike offers. transformers.js maps `q8` to the `_quantized` file
 * and `fp16` to `_fp16`; on wasm it would default to `q8` and on webgpu to `fp32`, so
 * the spike always asks explicitly. Both backends run the same precision, or the
 * comparison measures the quantisation rather than the backend.
 */
export type SpikeDtype = 'q8' | 'fp16' | 'fp32';

export interface ModelDownload {
  /** What to call it on screen. */
  readonly label: string;
  /** The Hugging Face repository. */
  readonly repo: string;
  /** SPDX identifier as the repository states it. */
  readonly licence: string;
  /** Bytes fetched on first use, at the precision being asked for. */
  readonly bytes: number;
  /** Where the user can go and look before agreeing. */
  readonly sourceUrl: string;
  /** Which stage of the pipeline needs it. */
  readonly stage: 'vad' | 'stt' | 'tts';
}

const SILERO: ModelDownload = {
  label: 'Silero VAD',
  repo: 'onnx-community/silero-vad',
  licence: 'MIT',
  // Loaded directly through onnxruntime-web, always the fp32 graph: it is 2 MB, and
  // quantising a model this small buys nothing.
  bytes: 2_243_022,
  sourceUrl: 'https://huggingface.co/onnx-community/silero-vad',
  stage: 'vad',
};

/** Byte sizes per precision, read from the HF API rather than estimated. */
const SIZES = {
  q8: {
    // encoder_model_quantized.onnx + decoder_model_merged_quantized.onnx
    moonshine: 7_940_000 + 20_240_000,
    // model_quantized.onnx
    kokoro: 92_360_000,
  },
  fp16: {
    // encoder_model_fp16.onnx + decoder_model_merged_fp16.onnx
    moonshine: 15_520_000 + 76_250_000,
    // model_fp16.onnx
    kokoro: 163_230_000,
  },
  // The unquantised graphs. Large, but the reference point: if recognition is correct
  // here and wrong at q8, the quantisation is the fault rather than the pipeline.
  fp32: {
    // encoder_model.onnx + decoder_model_merged.onnx
    moonshine: 30_880_000 + 78_230_000,
    // model.onnx
    kokoro: 325_530_000,
  },
} as const satisfies Record<SpikeDtype, { moonshine: number; kokoro: number }>;

/** Everything the spike fetches at a given precision, in pipeline order. */
export function modelsFor(dtype: SpikeDtype): readonly ModelDownload[] {
  return [
    SILERO,
    {
      label: `Moonshine tiny (speech to text, ${dtype})`,
      repo: 'onnx-community/moonshine-tiny-ONNX',
      licence: 'MIT',
      bytes: SIZES[dtype].moonshine,
      sourceUrl: 'https://huggingface.co/onnx-community/moonshine-tiny-ONNX',
      stage: 'stt',
    },
    {
      label: `Kokoro 82M (text to speech, ${dtype})`,
      repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      licence: 'Apache-2.0',
      bytes: SIZES[dtype].kokoro,
      sourceUrl: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
      stage: 'tts',
    },
  ];
}

/**
 * What Spike D (P0-T07) would download. Separate from `modelsFor`: it is a different
 * page with a different consent screen, and bundling both lists would ask for permission
 * to fetch 400 MB of speech models in order to run an 8 MB endpointer.
 *
 * Sizes are the exact bytes of the files, read on 2026-09-08 (`docs/SURFACE.md`). The
 * builds are the same model at two precisions — cpu is int8, gpu is fp32 — and the spike
 * runs both, because Spike A found int8 silently broken on WebGPU.
 */
export function smartTurnModel(build: 'cpu' | 'gpu'): ModelDownload {
  return {
    label: `Smart Turn v3.2 (turn detection, ${build === 'cpu' ? 'int8' : 'fp32'})`,
    repo: 'pipecat-ai/smart-turn-v3',
    licence: 'BSD-2-Clause',
    bytes: build === 'cpu' ? 8_679_182 : 32_411_198,
    sourceUrl: 'https://huggingface.co/pipecat-ai/smart-turn-v3',
    stage: 'vad',
  };
}

/** Spike D needs Silero to find the pauses, and Smart Turn to judge them. */
export function turnModelsFor(build: 'cpu' | 'gpu'): readonly ModelDownload[] {
  return [SILERO, smartTurnModel(build)];
}

export function totalBytes(models: readonly ModelDownload[]): number {
  return models.reduce((sum, model) => sum + model.bytes, 0);
}

/** Megabytes to one decimal, which is the honest precision for a download estimate. */
export function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
