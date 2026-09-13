/// <reference lib="webworker" />
import {
  SMART_TURN,
  modelUrl,
  smartTurnCombinationBlocker,
  type SmartTurnBackend,
  type SmartTurnBuild,
  type SmartTurnRequest,
  type SmartTurnResponse,
} from './messages';
import { SmartTurnModel, createSmartTurnSession } from './smart-turn';

/**
 * Smart Turn v3 in a worker (P1-T07), promoted from Spike D's `smart-turn.worker.ts`.
 *
 * The model code is `smart-turn.ts`; this file is the message loop around it. Durations
 * only are reported — a dedicated worker has its own `performance.timeOrigin`, so the
 * page stamps arrivals on the one clock that measures the whole pipeline.
 */

function post(message: SmartTurnResponse): void {
  // The empty transfer list is the worker overload; a target origin belongs to windows.
  (self as unknown as Worker).postMessage(message, []);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'number') {
    return `ONNX Runtime wasm exception (pointer ${error}) — usually an unsupported op or dtype for this backend`;
  }
  return String(error);
}

let model: SmartTurnModel | null = null;
/** Judgements accepted and not yet answered. A cancel only means something for these. */
const pending = new Set<number>();
const cancelled = new Set<number>();
/**
 * One judgement at a time. A superseded candidate's judgement can still be queued when
 * the next one arrives, and running both at once on one session measures contention.
 */
let queue: Promise<void> = Promise.resolve();

async function load(build: SmartTurnBuild, backend: SmartTurnBackend): Promise<void> {
  const blocker = smartTurnCombinationBlocker(backend, build);
  // Refused here as well as in the driver: this is the boundary that touches the runtime,
  // so no caller reaches the combination by forgetting to ask (ADR-21).
  if (blocker !== null) throw new Error(blocker);
  // onnxruntime-web given only `webgpu` and no adapter fails with an opaque message; say
  // which thing is missing instead.
  if (backend === 'webgpu' && !('gpu' in navigator)) {
    throw new Error('WebGPU is not available in this worker; the fp32 Smart Turn build needs it, or use int8 on wasm');
  }

  const started = performance.now();
  model = new SmartTurnModel(await createSmartTurnSession(modelUrl(SMART_TURN[build]), backend));
  post({ type: 'ready', loadMs: performance.now() - started, build, backend });
}

async function judge(requestId: number, samples: Float32Array): Promise<void> {
  try {
    if (cancelled.has(requestId)) {
      post({ type: 'cancelled', requestId });
      return;
    }
    if (model === null) throw new Error('judge before load');
    const result = await model.judge(samples);
    // Cancelled while running: the work is spent, but the driver asked not to hear it.
    if (cancelled.has(requestId)) post({ type: 'cancelled', requestId });
    else post({ type: 'probability', requestId, ...result });
  } catch (error) {
    post({ type: 'error', requestId, message: describe(error) });
  } finally {
    pending.delete(requestId);
    cancelled.delete(requestId);
  }
}

self.addEventListener('message', (event: MessageEvent<SmartTurnRequest>) => {
  const message = event.data;
  if (message.type === 'load') {
    load(message.build, message.backend).catch((error: unknown) =>
      post({ type: 'error', requestId: null, message: describe(error) }),
    );
  } else if (message.type === 'judge') {
    pending.add(message.requestId);
    queue = queue.then(() => judge(message.requestId, message.samples));
  } else if (pending.has(message.requestId)) {
    cancelled.add(message.requestId);
  }
});
