import { kokoroVoices } from '../kokoro/voices';

/**
 * Which files each pinned source is asked for (P9-T05, ADR-70). No sizes or hashes here, so
 * `tools/pin-models.ts` can read it before `pins.ts` exists. Established by downloading into an
 * empty cache (`docs/SURFACE.md`): a list that misses a required file fails the load loudly,
 * because `pinned-fetch.ts` answers anything unlisted with a 404.
 */

export const KOKORO_MODEL_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';

/** kokoro-js 1.2.1 fetches voices from the plain export whichever model it loaded, from `main`. */
export const KOKORO_VOICES_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export const KOKORO_CONFIG_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'] as const;

/** transformers.js maps a dtype to a file suffix; `q8` is `_quantized`, not anything with q8 in it. */
export const KOKORO_GRAPHS = {
  q8: 'onnx/model_quantized.onnx',
  fp16: 'onnx/model_fp16.onnx',
  fp32: 'onnx/model.onnx',
} as const;

export const KOKORO_VOICE_FILES: readonly string[] = kokoroVoices.map((voice) => `voices/${voice.id}.bin`);

/** The non-graph files transformers.js fetches for a recognition model. */
export const ASR_CONFIG_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'] as const;

/** transformers.js 3.8.1's `DEFAULT_DTYPE_SUFFIX_MAPPING`, for the precisions offered. */
export const ASR_DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4', q4f16: '_q4f16' } as const;

export type AsrDtypeKey = keyof typeof ASR_DTYPE_SUFFIX;

/** Every file of a precision, the two graphs first. */
export function asrFiles(dtype: AsrDtypeKey): readonly string[] {
  const suffix = ASR_DTYPE_SUFFIX[dtype];
  return [`onnx/encoder_model${suffix}.onnx`, `onnx/decoder_model_merged${suffix}.onnx`, ...ASR_CONFIG_FILES];
}

export const BODY_SOURCE = 'pixiv/three-vrm';
export const BODY_FILE = 'packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';
export const IDLE_CLIP_FILE = 'packages/three-vrm-animation/examples/models/test.vrma';

export const FACE_SOURCE = 'mediapipe/face_landmarker';
export const FACE_FILE = 'face_landmarker.task';
