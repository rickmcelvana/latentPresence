/// <reference lib="webworker" />
import { cachedModelFetch } from '../consent/model-cache';
import { SER_MODELS, parseHead, serFileModel, serFileUrl, type SerBackend, type SerModelKey, type SerRequest, type SerResponse } from './messages';
import { BaseSerModel, DistillSerModel, createSerSession, type SerModelLike } from './ser';

/**
 * Voice emotion in a worker (P3-T05). The model code is `ser.ts`; this is the message loop.
 * Same shape and the same rule as `smart-turn.worker.ts`: the weights are fetched here
 * through `cachedModelFetch`, size-checked against the catalog, never handed to ort as a
 * URL where nothing of ours could see the request (P1-T13).
 */

function post(message: SerResponse): void {
  (self as unknown as Worker).postMessage(message, []);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'number') return `ONNX Runtime wasm exception (pointer ${error}) — usually an unsupported op or dtype for this backend`;
  return String(error);
}

let model: SerModelLike | null = null;
/** One segment at a time: two runs on one session measure contention, not the model. */
let queue: Promise<void> = Promise.resolve();

async function load(key: SerModelKey, backend: SerBackend): Promise<void> {
  if (backend === 'webgpu' && !('gpu' in navigator)) throw new Error('WebGPU is not available in this worker; use the light model on wasm');
  const started = performance.now();
  const spec = SER_MODELS[key];
  const bytes = await Promise.all(spec.files.map((file) => cachedModelFetch(serFileUrl(key, file), serFileModel(key, file))));
  const [graph, head] = bytes;
  if (graph === undefined) throw new Error(`${key}: no graph`);
  const session = await createSerSession(graph, backend);
  const loaded =
    key === 'base'
      ? new BaseSerModel(session as unknown as ConstructorParameters<typeof BaseSerModel>[0], parseHead(JSON.parse(new TextDecoder().decode(head))))
      : new DistillSerModel(session);
  // One throwaway run: on WebGPU the first inference compiles its shaders (P1-T08 measured
  // 400–480 ms for Smart Turn's), which would otherwise land on the user's first sentence.
  const warmUp = new Float32Array(16_000);
  for (let i = 0; i < warmUp.length; i += 1) warmUp[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / 16_000);
  await loaded.classify(warmUp);
  model = loaded;
  post({ type: 'ready', loadMs: performance.now() - started, model: key, backend });
}

async function classify(requestId: number, samples: Float32Array): Promise<void> {
  try {
    if (model === null) throw new Error('classify before load');
    const result = await model.classify(samples);
    post({ type: 'result', requestId, ...result });
  } catch (error) {
    post({ type: 'error', requestId, message: describe(error) });
  }
}

self.addEventListener('message', (event: MessageEvent<SerRequest>) => {
  const message = event.data;
  if (message.type === 'load') {
    load(message.model, message.backend).catch((error: unknown) => post({ type: 'error', requestId: null, message: describe(error) }));
  } else {
    queue = queue.then(() => classify(message.requestId, message.samples));
  }
});
