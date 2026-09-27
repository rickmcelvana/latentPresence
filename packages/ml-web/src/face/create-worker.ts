import type { FaceRequest, FaceResponse, FaceWorkerPort } from './messages';
import { workerPort } from '../worker-port';

/**
 * The real face worker behind the port its driver talks to (P3-T06). Not re-exported from
 * the barrel: the gated factory in `consent/gated-workers.ts` is the only way in (P1-T13).
 */
export function createFaceWorker(): FaceWorkerPort {
  const worker = new Worker(new URL('./face.worker.ts', import.meta.url), { type: 'module' });
  return workerPort<FaceRequest, FaceResponse>(worker, 'face', (message) => ({ type: 'error', requestId: null, message }));
}
