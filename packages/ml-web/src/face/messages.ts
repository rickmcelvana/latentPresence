import type { ModelDescriptor } from '@latentpresence/protocol';

/**
 * The user's face in a worker (P3-T06): the catalog, the worker protocol and the one rule
 * about network access. No MediaPipe here, so the barrel stays safe to import on the main
 * thread; the landmarker itself is `face.worker.ts`.
 *
 * **MediaPipe Tasks Vision is pinned to 0.10.35, the last release without telemetry.**
 * 1.0.0 (2026-07-28) added a usage logger that is on by default and has no switch: every
 * task builds one, and it POSTs protobuf metrics to `odml.pa.googleapis.com/v1/log` every
 * 60 s with an API key baked into the wasm; the README's new privacy notice makes informing
 * users the app's job. This project sends nothing anywhere (CLAUDE.md), so the version is
 * pinned (ADR-34) and the worker refuses any request it did not expect (`allowedRequest`),
 * which is what catches the logger if the pin is ever lifted by accident. Read from the
 * package itself on 2026-09-25 (`docs/SURFACE.md`).
 */

/**
 * `face_landmarker.task`: BlazeFace short-range, Face Mesh V2 and Blendshape V2 in one
 * bundle, float16. Version `1` in the path is the one the docs call `latest` today — same
 * ETag, same 3,758,596 bytes (read 2026-09-25) — and is pinned so `latest` moving never
 * changes what a user agreed to. All three model cards say Apache-2.0.
 */
export const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export const FACE_MODEL: ModelDescriptor = {
  id: 'mediapipe/face_landmarker@float16-1',
  label: 'MediaPipe Face Landmarker (reads your expression from the camera)',
  sizeBytes: 3_758_596,
  licence: 'Apache-2.0',
  sourceUrl: 'https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker',
};

/** What the consent screen shows before the face model is fetched. */
export function faceModels(): ModelDescriptor[] {
  return [FACE_MODEL];
}

/**
 * The only requests the face worker may make: its own origin (the wasm loader and binary,
 * served with the app) and the one model file. Anything else — a telemetry endpoint above
 * all — is refused before it leaves the worker.
 */
export function allowedRequest(url: string, origin: string): boolean {
  if (url === FACE_MODEL_URL) return true;
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

export type FaceDelegate = 'GPU' | 'CPU';

/** 52 ARKit-named blendshape scores, 0…1, keyed by MediaPipe's `categoryName`. */
export type Blendshapes = Readonly<Record<string, number>>;

/** Main thread to the face worker. */
export type FaceRequest =
  | { readonly type: 'load'; readonly delegate: FaceDelegate }
  /**
   * One camera frame, transferred. The worker closes it as soon as the landmarker has read
   * it, whatever happens — nothing keeps a frame (the plan's "no frames stored").
   */
  | { readonly type: 'frame'; readonly requestId: number; readonly frame: ImageBitmap; readonly timestamp: number };

/** Face worker to main thread. `blendshapes` is null when there is no face in the frame. */
export type FaceResponse =
  | { readonly type: 'ready'; readonly loadMs: number; readonly delegate: FaceDelegate }
  | { readonly type: 'result'; readonly requestId: number; readonly blendshapes: Blendshapes | null; readonly inferenceMs: number }
  | { readonly type: 'error'; readonly requestId: number | null; readonly message: string };

export interface FaceWorkerPort {
  post(message: FaceRequest, transfer?: readonly Transferable[]): void;
  onMessage(listener: (message: FaceResponse) => void): () => void;
  terminate(): void;
}

// ── What the worker does with a frame, without MediaPipe ────────────────────────────

/** The slice of `FaceLandmarker` the worker uses, so the frame rule is testable in node. */
export interface LandmarkerLike {
  detectForVideo(
    frame: ImageBitmap,
    timestamp: number,
  ): { readonly faceBlendshapes: readonly { readonly categories: readonly { readonly categoryName: string; readonly score: number }[] }[] };
}

/**
 * Read one frame and **close it, always** — on success, on a throw, on a frame with no face.
 * The bitmap is the only copy of the pixels this side of the camera, and closing it is what
 * "no frames stored" means in code. MediaPipe wants strictly increasing timestamps in video
 * mode, so the caller's are passed through untouched.
 */
export function readFrame(landmarker: LandmarkerLike, frame: ImageBitmap, timestamp: number): Blendshapes | null {
  try {
    const result = landmarker.detectForVideo(frame, timestamp);
    const face = result.faceBlendshapes[0];
    if (face === undefined || face.categories.length === 0) return null;
    return Object.fromEntries(face.categories.map((category) => [category.categoryName, category.score]));
  } finally {
    frame.close();
  }
}
