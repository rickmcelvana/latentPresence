import type { SerRequest, SerResponse, SerWorkerPort } from './messages';
import { workerPort } from '../worker-port';

/**
 * The real voice-emotion worker behind the port its driver talks to (P3-T05). Not
 * re-exported from the barrel: the gated factory in `consent/gated-workers.ts` is the only
 * way in (P1-T13).
 */
export function createSerWorker(): SerWorkerPort {
  const worker = new Worker(new URL('./ser.worker.ts', import.meta.url), { type: 'module' });
  return workerPort<SerRequest, SerResponse>(worker, 'voice-emotion', (message) => ({ type: 'error', requestId: null, message }));
}
