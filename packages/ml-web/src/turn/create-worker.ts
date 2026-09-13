import type {
  SmartTurnRequest,
  SmartTurnResponse,
  SmartTurnWorkerPort,
  VadRequest,
  VadResponse,
  VadWorkerPort,
} from './messages';

/**
 * Real turn-detection workers, wrapped in the ports the drivers talk to (P1-T07).
 *
 * The `new URL(..., import.meta.url)` form is what Vite recognises as a worker entry.
 * Nothing here runs in node, so it has no test: the contracts worth testing are the
 * ports, and the drivers in `packages/providers` test against fakes of them.
 */

export function createVadWorker(): VadWorkerPort {
  const worker = new Worker(new URL('./vad.worker.ts', import.meta.url), { type: 'module' });
  return {
    post(message: VadRequest, transfer: readonly Transferable[] = []): void {
      worker.postMessage(message, [...transfer]);
    },
    onMessage(listener: (message: VadResponse) => void): () => void {
      const handler = (event: MessageEvent<VadResponse>): void => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
    terminate(): void {
      worker.terminate();
    },
  };
}

export function createSmartTurnWorker(): SmartTurnWorkerPort {
  const worker = new Worker(new URL('./smart-turn.worker.ts', import.meta.url), { type: 'module' });
  return {
    post(message: SmartTurnRequest, transfer: readonly Transferable[] = []): void {
      worker.postMessage(message, [...transfer]);
    },
    onMessage(listener: (message: SmartTurnResponse) => void): () => void {
      const handler = (event: MessageEvent<SmartTurnResponse>): void => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
    terminate(): void {
      worker.terminate();
    },
  };
}
