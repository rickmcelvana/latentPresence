import type { AsrRequest, AsrResponse, AsrWorkerPort } from './messages';

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
  return {
    post(message: AsrRequest, transfer: readonly Transferable[] = []): void {
      worker.postMessage(message, [...transfer]);
    },
    onMessage(listener: (message: AsrResponse) => void): () => void {
      const handler = (event: MessageEvent<AsrResponse>): void => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
    terminate(): void {
      worker.terminate();
    },
  };
}
