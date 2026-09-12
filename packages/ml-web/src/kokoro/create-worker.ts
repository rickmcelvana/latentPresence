import type { KokoroRequest, KokoroResponse, KokoroWorkerPort } from './messages';

/**
 * A real Kokoro worker, wrapped in the port the provider talks to (P1-T05).
 *
 * The `new URL(..., import.meta.url)` form is what Vite recognises as a worker entry, so
 * `kokoro.worker.ts` is compiled and emitted as its own chunk rather than pulled into
 * the page. Nothing here runs in node, which is why it has no test: the contract worth
 * testing is `KokoroWorkerPort`, and `KokoroBrowserTTSProvider` tests against a fake one.
 *
 * **This is the function that puts `kokoro-js` in a production chunk.** Until something
 * calls it, `apps/web/vite.config.ts`'s spike guard stays green; when the TTS pipeline is
 * wired up (P1-T08, P1-T10) the guard's `kokoro-js` entry comes out, deliberately, which
 * is what its own docstring asks for.
 */
export function createKokoroWorker(): KokoroWorkerPort {
  const worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' });
  return {
    post(message: KokoroRequest, transfer: readonly Transferable[] = []): void {
      worker.postMessage(message, [...transfer]);
    },
    onMessage(listener: (message: KokoroResponse) => void): () => void {
      const handler = (event: MessageEvent<KokoroResponse>): void => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
    terminate(): void {
      worker.terminate();
    },
  };
}
