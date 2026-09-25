import type { FaceRequest, FaceResponse, FaceWorkerPort } from './messages';

/**
 * The real face worker behind the port its driver talks to (P3-T06). Not re-exported from
 * the barrel: the gated factory in `consent/gated-workers.ts` is the only way in (P1-T13).
 */
export function createFaceWorker(): FaceWorkerPort {
  const worker = new Worker(new URL('./face.worker.ts', import.meta.url), { type: 'module' });
  return {
    post(message: FaceRequest, transfer: readonly Transferable[] = []): void {
      worker.postMessage(message, [...transfer]);
    },
    onMessage(listener: (message: FaceResponse) => void): () => void {
      const handler = (event: MessageEvent<FaceResponse>): void => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
    terminate(): void {
      worker.terminate();
    },
  };
}
