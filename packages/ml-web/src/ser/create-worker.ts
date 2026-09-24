import type { SerRequest, SerResponse, SerWorkerPort } from './messages';

/**
 * The real voice-emotion worker behind the port its driver talks to (P3-T05). Not
 * re-exported from the barrel: the gated factory in `consent/gated-workers.ts` is the only
 * way in (P1-T13).
 */
export function createSerWorker(): SerWorkerPort {
  const worker = new Worker(new URL('./ser.worker.ts', import.meta.url), { type: 'module' });
  return {
    post(message: SerRequest, transfer: readonly Transferable[] = []): void {
      worker.postMessage(message, [...transfer]);
    },
    onMessage(listener: (message: SerResponse) => void): () => void {
      const handler = (event: MessageEvent<SerResponse>): void => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
    terminate(): void {
      worker.terminate();
    },
  };
}
