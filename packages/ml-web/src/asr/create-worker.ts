import type { AsrRequest, AsrResponse, AsrWorkerPort } from './messages';
import { workerPort } from '../worker-port';

/**
 * A real recognition worker, wrapped in the port the providers talk to (P1-T06).
 *
 * The `new URL(..., import.meta.url)` form is what Vite recognises as a worker entry, so
 * `asr.worker.ts` becomes its own chunk rather than joining the page bundle. Nothing here
 * runs in node, which is why it has no test: the contract worth testing is `AsrWorkerPort`,
 * and the browser providers test against a fake one.
 */
export function createAsrWorker(): AsrWorkerPort {
  const worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' });
  return workerPort<AsrRequest, AsrResponse>(worker, 'recognition', (message) => ({ type: 'error', requestId: null, message }));
}
