/// <reference lib="webworker" />
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import { cachedModelFetch } from '../consent/model-cache';
import { FACE_MODEL, FACE_MODEL_URL, allowedRequest, readFrame, type FaceDelegate, type FaceRequest, type FaceResponse } from './messages';

/**
 * The user's face in a worker (P3-T06). The frame rule is `readFrame` in `messages.ts`;
 * this is the message loop and the load.
 *
 * - **The model comes through `cachedModelFetch`** and is handed over as bytes
 *   (`modelAssetBuffer`), never as a path MediaPipe would fetch itself (P1-T13's rule).
 * - **The wasm is ours**, served with the app from the pinned package — the ES-module build,
 *   because MediaPipe's loader tries `importScripts` first, which a module worker refuses
 *   with a `TypeError`, and then falls back to `import()`, which the module build answers.
 * - **Every request this worker makes is checked first** (`allowedRequest`); see
 *   `messages.ts` for why the telemetry in MediaPipe 1.x makes that more than tidiness.
 */

const nativeFetch = self.fetch.bind(self);
self.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (!allowedRequest(url, self.location.origin)) return Promise.reject(new Error(`face worker: refused a request to ${url}`));
  return nativeFetch(input, init);
};

function post(message: FaceResponse): void {
  (self as unknown as Worker).postMessage(message, []);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let landmarker: FaceLandmarker | null = null;

async function load(delegate: FaceDelegate): Promise<void> {
  const started = performance.now();
  const model = await cachedModelFetch(FACE_MODEL_URL, FACE_MODEL);
  landmarker = await FaceLandmarker.createFromOptions(
    { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl },
    {
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    },
  );
  post({ type: 'ready', loadMs: performance.now() - started, delegate });
}

self.addEventListener('message', (event: MessageEvent<FaceRequest>) => {
  const message = event.data;
  if (message.type === 'load') {
    load(message.delegate).catch((error: unknown) => post({ type: 'error', requestId: null, message: describe(error) }));
    return;
  }
  const current = landmarker;
  if (current === null) {
    message.frame.close();
    post({ type: 'error', requestId: message.requestId, message: 'frame before load' });
    return;
  }
  const started = performance.now();
  try {
    const blendshapes = readFrame(current, message.frame, message.timestamp);
    post({ type: 'result', requestId: message.requestId, blendshapes, inferenceMs: performance.now() - started });
  } catch (error) {
    post({ type: 'error', requestId: message.requestId, message: describe(error) });
  }
});
