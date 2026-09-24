import type { ModelDescriptor, UserEmotion } from '@latentpresence/protocol';

/**
 * Speech emotion recognition in a worker (P3-T05): the contracts, the catalog and the pure
 * arithmetic that turns a model's output into a reading. No ONNX Runtime here, so the
 * barrel stays safe to import on the main thread.
 *
 * **Two models, both emotion2vec+ derivatives under the FunASR Model Open Source Licence
 * 1.1** (free to use, copy, modify and share; attribution and the model names must be
 * kept; "for reference and learning purposes"; revisions take effect on publication).
 * Chosen with Rick 2026-09-24 (ADR-33), twice — the second time on the numbers:
 *
 * - **`distill`** (default) — a 2.2M-parameter student of emotion2vec+ large: a 3 s window
 *   in, 18 "pose" cosines out, mel frontend inside the graph. 9.7 MB on wasm, **24–51 ms per
 *   segment in a browser worker** at any length, and it leaves the GPU to Kokoro. Its own
 *   card says it misses most feeling in natural speech (~14% agreement with its teacher on
 *   non-calm windows), so it under-reacts rather than mis-reacts; text and `[user:x]`
 *   carry what it misses.
 * - **`base`** (accurate, opt-in) — `emotion2vec_plus_base` exported to ONNX: a 768-d frame
 *   backbone plus a 9×768 linear head in JSON; its nine labels *are* `UserEmotion`. 373 MB
 *   fp32 on WebGPU, where its cost grows with the square of the length (63 ms at 1 s,
 *   349 ms at 3 s, 1.3 s at 6 s), so it hears only the last `BASE_MAX_SECONDS`.
 *
 * Revisions, sizes and the distill's constants were read from the Hugging Face API and the
 * files themselves on 2026-09-24 (`docs/SURFACE.md`).
 */

export const SER_SAMPLE_RATE = 16_000;

export type SerModelKey = 'distill' | 'base';

/** The default voice-emotion model (ADR-33). */
export const DEFAULT_SER_MODEL: SerModelKey = 'distill';
export type SerBackend = 'webgpu' | 'wasm';

interface SerFile {
  readonly file: string;
  /** Exact bytes at `revision`, from the tree API. */
  readonly bytes: number;
}

interface SerModelSpec {
  readonly repo: string;
  readonly revision: string;
  readonly label: string;
  readonly licence: string;
  /** Everything fetched, the graph first. Each one is a line on the consent screen. */
  readonly files: readonly SerFile[];
}

const LICENCE = 'FunASR Model Open Source License 1.1 (attribution required)';

export const SER_MODELS: Readonly<Record<SerModelKey, SerModelSpec>> = {
  base: {
    repo: 'pankotaro/emotion2vec-plus-base-onnx',
    revision: '334d4376993c381f059cc36d2c6ed05cbfec5ca1',
    label: 'emotion2vec+ base (voice emotion), fp32',
    licence: LICENCE,
    files: [
      { file: 'emotion2vec_plus_base.onnx', bytes: 373_159_295 },
      { file: 'emotion2vec_head.json', bytes: 128_472 },
    ],
  },
  distill: {
    repo: 'thomashallock/emotion2vec-web-distill',
    revision: '566a831be26e64f7e641241c26154793b7dd1428',
    label: 'emotion2vec web distill v4 (voice emotion, light)',
    licence: LICENCE,
    files: [{ file: 'distill-student-v4.fused.onnx', bytes: 9_695_687 }],
  },
};

/** The backend each model runs on: base is ~3.5× slower on wasm than WebGPU, the distill is fine on wasm (SURFACE). */
export const SER_BACKEND: Readonly<Record<SerModelKey, SerBackend>> = { base: 'webgpu', distill: 'wasm' };

export function serFileUrl(key: SerModelKey, file: SerFile): string {
  const spec = SER_MODELS[key];
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file.file}`;
}

/** One consent line per file, so each is size-checked on its own as it is fetched. */
export function serFileModel(key: SerModelKey, file: SerFile): ModelDescriptor {
  const spec = SER_MODELS[key];
  const part = file === spec.files[0] ? '' : ` — ${file.file}`;
  return {
    id: `${spec.repo}@${spec.revision.slice(0, 7)}:${file.file}`,
    label: `${spec.label}${part}`,
    sizeBytes: file.bytes,
    licence: spec.licence,
    sourceUrl: `https://huggingface.co/${spec.repo}`,
  };
}

/** What the consent screen shows before a voice-emotion model is fetched. */
export function serModels(key: SerModelKey): ModelDescriptor[] {
  return SER_MODELS[key].files.map((file) => serFileModel(key, file));
}

// ── The base model: frames → mean → linear head → softmax ───────────────────────────

/** `emotion2vec_head.json`'s order, which is `UserEmotion`'s vocabulary (`<unk>` is `unknown`). */
export const BASE_LABELS: readonly UserEmotion[] = ['angry', 'disgusted', 'fearful', 'happy', 'neutral', 'other', 'sad', 'surprised', 'unknown'];

export interface LinearHead {
  readonly weight: readonly (readonly number[])[];
  readonly bias: readonly number[];
}

/** Checks the head file is what the catalog promised, before it is trusted with a number. */
export function parseHead(json: unknown): LinearHead {
  const head = json as { labels?: unknown; weight?: unknown; bias?: unknown };
  if (JSON.stringify(head.labels) !== JSON.stringify(BASE_LABELS)) {
    throw new Error(`emotion2vec head labels ${JSON.stringify(head.labels)} are not the nine expected`);
  }
  const weight = head.weight as number[][];
  const bias = head.bias as number[];
  if (!Array.isArray(weight) || weight.length !== 9 || weight.some((row) => row.length !== 768) || !Array.isArray(bias) || bias.length !== 9) {
    throw new Error('emotion2vec head is not 9×768 with 9 biases');
  }
  return { weight, bias };
}

function softmax(logits: readonly number[]): number[] {
  const top = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - top));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((value) => value / sum);
}

/** Per-frame features `[frames × dim]`, flat, to class probabilities: mean-pool, head, softmax. */
export function classifyFrames(features: Float32Array, frames: number, dim: number, head: LinearHead): number[] {
  const pooled = new Float64Array(dim);
  for (let f = 0; f < frames; f += 1) {
    for (let d = 0; d < dim; d += 1) pooled[d] = (pooled[d] ?? 0) + (features[f * dim + d] ?? 0);
  }
  for (let d = 0; d < dim; d += 1) pooled[d] = (pooled[d] ?? 0) / Math.max(1, frames);
  const logits = head.weight.map((row, k) => row.reduce((sum, w, d) => sum + w * (pooled[d] ?? 0), head.bias[k] ?? 0));
  return softmax(logits);
}

// ── The distill: 3 s windows → 18 pose cosines → softmax(x / T) ─────────────────────

/** From `distill-student-v4.fused-meta.json` at the pinned revision. */
export const DISTILL_WINDOW_SAMPLES = 48_000;
export const DISTILL_TEMPERATURE = 0.0375;
export const DISTILL_POSES = [
  'calm', 'content', 'warm', 'happy', 'amused', 'excited', 'surprised', 'smug', 'confused',
  'skeptical', 'annoyed', 'disgusted', 'afraid', 'angry', 'tense', 'sad', 'weary', 'bored',
] as const;
export type DistillPose = (typeof DISTILL_POSES)[number];

/**
 * Each pose as a `UserEmotion`: the class that dominates its anchor mix
 * (`distill-anchor-mix.json`), with the non-neutral side of a 50/50 tie — `content` is
 * half happy, `confused` half surprised, `tense` half angry.
 */
export const POSE_LABEL: Readonly<Record<DistillPose, UserEmotion>> = {
  calm: 'neutral', content: 'happy', warm: 'happy', happy: 'happy', amused: 'happy', excited: 'happy',
  surprised: 'surprised', smug: 'happy', confused: 'surprised', skeptical: 'neutral', annoyed: 'angry',
  disgusted: 'disgusted', afraid: 'fearful', angry: 'angry', tense: 'angry', sad: 'sad', weary: 'sad', bored: 'neutral',
};

/** Pose weights, averaged over however many windows ran as one batch. */
export function poseWeights(cosines: Float32Array, windows: number): number[] {
  const n = DISTILL_POSES.length;
  const mean = Array.from({ length: n }, () => 0);
  for (let w = 0; w < windows; w += 1) {
    const weights = softmax(Array.from(cosines.subarray(w * n, (w + 1) * n), (value) => value / DISTILL_TEMPERATURE));
    for (let k = 0; k < n; k += 1) mean[k] = (mean[k] ?? 0) + (weights[k] ?? 0) / windows;
  }
  return mean;
}

/** Pose weights folded into `UserEmotion` probabilities, in `BASE_LABELS` order. */
export function poseProbabilities(weights: readonly number[]): number[] {
  const out = Array.from({ length: BASE_LABELS.length }, () => 0);
  DISTILL_POSES.forEach((pose, k) => {
    const index = BASE_LABELS.indexOf(POSE_LABEL[pose]);
    out[index] = (out[index] ?? 0) + (weights[k] ?? 0);
  });
  return out;
}

/**
 * The segment as the distill takes it: up to `maxWindows` 3 s windows from the end, the
 * earliest zero-padded in front when the segment is short. Flat, `[windows × 48000]`.
 */
export function distillWindows(samples: Float32Array, maxWindows = 2): { readonly data: Float32Array; readonly windows: number } {
  const windows = Math.max(1, Math.min(maxWindows, Math.ceil(samples.length / DISTILL_WINDOW_SAMPLES)));
  const data = new Float32Array(windows * DISTILL_WINDOW_SAMPLES);
  const take = Math.min(samples.length, data.length);
  data.set(samples.subarray(samples.length - take), data.length - take);
  return { data, windows };
}

/**
 * The base model hears only the last 1.5 s of a segment: 108 ms median in a browser worker
 * on WebGPU (RTX 5060 Ti), against 171 ms at 2 s and the done-when's 150 (ADR-33).
 */
export const BASE_MAX_SECONDS = 1.5;

// ── Worker protocol ─────────────────────────────────────────────────────────────────

/** Main thread to the SER worker. */
export type SerRequest =
  | { readonly type: 'load'; readonly model: SerModelKey; readonly backend: SerBackend }
  /** One user speech segment, 16 kHz mono. Transferred. */
  | { readonly type: 'classify'; readonly requestId: number; readonly samples: Float32Array };

/** SER worker to main thread. `probabilities` are in `BASE_LABELS` order. */
export type SerResponse =
  | { readonly type: 'ready'; readonly loadMs: number; readonly model: SerModelKey; readonly backend: SerBackend }
  | {
      readonly type: 'result';
      readonly requestId: number;
      readonly probabilities: readonly number[];
      readonly inferenceMs: number;
      /** Seconds of audio the model actually heard. */
      readonly seconds: number;
    }
  | { readonly type: 'error'; readonly requestId: number | null; readonly message: string };

export interface SerWorkerPort {
  post(message: SerRequest, transfer?: readonly Transferable[]): void;
  onMessage(listener: (message: SerResponse) => void): () => void;
  terminate(): void;
}
