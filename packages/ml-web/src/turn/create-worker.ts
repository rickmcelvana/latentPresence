import type {
  SmartTurnRequest,
  SmartTurnResponse,
  SmartTurnWorkerPort,
  VadRequest,
  VadResponse,
  VadWorkerPort,
} from './messages';
import { workerPort } from '../worker-port';

/**
 * Real turn-detection workers, wrapped in the ports the drivers talk to (P1-T07).
 *
 * The `new URL(..., import.meta.url)` form is what Vite recognises as a worker entry.
 * Nothing here runs in node, so it has no test: the contracts worth testing are the
 * ports, and the drivers in `packages/providers` test against fakes of them.
 */

export function createVadWorker(): VadWorkerPort {
  const worker = new Worker(new URL('./vad.worker.ts', import.meta.url), { type: 'module' });
  return workerPort<VadRequest, VadResponse>(worker, 'Silero VAD', (message) => ({ type: 'error', message }));
}

export function createSmartTurnWorker(): SmartTurnWorkerPort {
  const worker = new Worker(new URL('./smart-turn.worker.ts', import.meta.url), { type: 'module' });
  return workerPort<SmartTurnRequest, SmartTurnResponse>(worker, 'Smart Turn', (message) => ({ type: 'error', requestId: null, message }));
}
