import type { ModelDescriptor } from '@latentpresence/protocol';

/**
 * The contracts between the turn-detection workers and whatever drives them (P1-T07).
 *
 * Same split as `../asr`: two thin workers here, the drivers in `packages/providers`
 * importing only these types, and the endpointing logic — which has no model in it at
 * all — in `packages/core/src/turn`.
 */

/** Silero and Smart Turn both run at 16 kHz, the same rate as recognition. */
export const TURN_MODEL_SAMPLE_RATE = 16_000;

/**
 * Silero v5's frame at 16 kHz: 512 samples, 32 ms. The reference wrapper raises on any
 * other length (`utils_vad.py`, `OnnxWrapper.__call__`), so this is a requirement, not a
 * preference.
 */
export const VAD_FRAME_SAMPLES = 512;

/**
 * Samples of the previous frame the reference prepends to each call at 16 kHz, making the
 * graph's real input 576 samples. Read out of `snakers4/silero-vad`'s
 * `src/silero_vad/utils_vad.py` on 2026-09-13; Spike A and D fed the bare 512.
 * `live/turn.ts` measures both on the same audio (`docs/SURFACE.md`).
 */
export const VAD_CONTEXT_SAMPLES = 64;

/**
 * The two Smart Turn v3.2 builds. They are the same 8M-parameter model at two precisions
 * (`docs/SURFACE.md`, "Smart Turn v3 input surface"), but not interchangeable: their
 * probabilities disagree by enough to cross a threshold in both directions.
 */
export type SmartTurnBuild = 'gpu' | 'cpu';
export type SmartTurnBackend = 'webgpu' | 'wasm';

interface TurnModelSpec {
  readonly repo: string;
  /** The commit the URL and size are pinned to. `main` can move under a consent screen. */
  readonly revision: string;
  readonly file: string;
  readonly label: string;
  readonly licence: string;
  /** Exact bytes of `file` at `revision`, from the Hugging Face tree API. */
  readonly bytes: number;
}

/**
 * Sizes read from `huggingface.co/api/models/<repo>/tree/<revision>` on 2026-09-13, and
 * the Silero figure confirmed by `X-Linked-Size` on the resolve URL and by downloading it.
 * Each model is a single file with no config beside it, so the listing *is* the download —
 * unlike the recognition models, where it overstated.
 */
export const SILERO_VAD: TurnModelSpec = {
  repo: 'onnx-community/silero-vad',
  revision: 'e71cae966052b992a7eca6b17738916ce0eca4ec',
  file: 'onnx/model.onnx',
  label: 'Silero VAD (voice activity)',
  licence: 'MIT',
  bytes: 2_243_022,
};

export const SMART_TURN: Readonly<Record<SmartTurnBuild, TurnModelSpec>> = {
  gpu: {
    repo: 'pipecat-ai/smart-turn-v3',
    revision: 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93',
    file: 'smart-turn-v3.2-gpu.onnx',
    label: 'Smart Turn v3.2 (turn detection), fp32',
    licence: 'BSD-2-Clause',
    bytes: 32_411_198,
  },
  cpu: {
    repo: 'pipecat-ai/smart-turn-v3',
    revision: 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93',
    file: 'smart-turn-v3.2-cpu.onnx',
    label: 'Smart Turn v3.2 (turn detection), int8',
    licence: 'BSD-2-Clause',
    bytes: 8_679_182,
  },
};

export function modelUrl(spec: TurnModelSpec): string {
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${spec.file}`;
}

function describeModel(spec: TurnModelSpec): ModelDescriptor {
  return {
    id: `${spec.repo}@${spec.revision.slice(0, 7)}:${spec.file}`,
    label: spec.label,
    sizeBytes: spec.bytes,
    licence: spec.licence,
    sourceUrl: `https://huggingface.co/${spec.repo}`,
  };
}

/** What the consent screen (P1-T13) shows before Silero is fetched. */
export function sileroVadModel(): ModelDescriptor {
  return describeModel(SILERO_VAD);
}

/** What the consent screen shows before a Smart Turn build is fetched. */
export function smartTurnModel(build: SmartTurnBuild): ModelDescriptor {
  return describeModel(SMART_TURN[build]);
}

/**
 * Why a build cannot run on a backend, or null when it can.
 *
 * **int8 on WebGPU is refused.** Spike D found it fails at load on real hardware and in
 * the bench alike — `[DequantizeLinear] ... In the case of dequantizing int32 there is no
 * zero point` — and ADR-21 says it must never be offered there. It fails loudly, unlike
 * Moonshine's q8, but a settings screen that offers a combination which cannot start is
 * still broken, and ADR-20's rule is that precision is chosen explicitly per stage.
 */
export function smartTurnCombinationBlocker(backend: SmartTurnBackend, build: SmartTurnBuild): string | null {
  if (backend === 'webgpu' && build === 'cpu') {
    return 'the int8 Smart Turn build is not offered on WebGPU: it does not load there (ADR-21). Use the fp32 build on WebGPU, or int8 on wasm for a machine without a GPU.';
  }
  return null;
}

/** Main thread to the VAD worker. */
export type VadRequest =
  | { readonly type: 'load' }
  /**
   * One frame of exactly `VAD_FRAME_SAMPLES` at 16 kHz. The buffer is transferred in and
   * transferred back with the answer, so a frame costs no copies either way.
   */
  | { readonly type: 'frame'; readonly samples: Float32Array; readonly at: number }
  /** Clear the recurrent state and context, as the reference does between streams. */
  | { readonly type: 'reset' };

/** VAD worker to main thread. */
export type VadResponse =
  | { readonly type: 'ready'; readonly loadMs: number }
  /** In the order frames were sent: the worker runs them one at a time. */
  | {
      readonly type: 'probability';
      readonly samples: Float32Array;
      readonly probability: number;
      readonly at: number;
    }
  | { readonly type: 'error'; readonly message: string };

/** Main thread to the Smart Turn worker. */
export type SmartTurnRequest =
  | { readonly type: 'load'; readonly build: SmartTurnBuild; readonly backend: SmartTurnBackend }
  | {
      readonly type: 'judge';
      readonly requestId: number;
      /** At most the last 8 s of the utterance, 16 kHz. The worker pads and normalises. */
      readonly samples: Float32Array;
    }
  /** Skip a judgement that has not started. One already running is ~40 ms and finishes. */
  | { readonly type: 'cancel'; readonly requestId: number };

/** Smart Turn worker to main thread. Durations only: a worker's clock is its own. */
export type SmartTurnResponse =
  | {
      readonly type: 'ready';
      readonly loadMs: number;
      readonly build: SmartTurnBuild;
      readonly backend: SmartTurnBackend;
    }
  | {
      readonly type: 'probability';
      readonly requestId: number;
      readonly probability: number;
      readonly featuresMs: number;
      readonly inferenceMs: number;
    }
  | { readonly type: 'cancelled'; readonly requestId: number }
  /** `requestId` is null for a failure that belongs to the worker rather than a request. */
  | { readonly type: 'error'; readonly requestId: number | null; readonly message: string };

/** The VAD worker as its driver sees it. Same structural shape as `AsrWorkerPort`. */
export interface VadWorkerPort {
  post(message: VadRequest, transfer?: readonly Transferable[]): void;
  onMessage(listener: (message: VadResponse) => void): () => void;
  terminate(): void;
}

/** The Smart Turn worker as its driver sees it. */
export interface SmartTurnWorkerPort {
  post(message: SmartTurnRequest, transfer?: readonly Transferable[]): void;
  onMessage(listener: (message: SmartTurnResponse) => void): () => void;
  terminate(): void;
}
