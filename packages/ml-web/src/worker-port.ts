/**
 * A real `Worker` as the port a driver talks to — messages in and out, and **a worker that
 * dies without a word becomes an error message**.
 *
 * A module worker whose script or one of its imports fails to load never runs a line, so it
 * never posts the `error` its own message loop would; the browser only fires the Worker's
 * `error` event, with no message. Every port used to listen to `message` alone, so a driver
 * waiting for `ready` waited forever: on 2026-09-27 `/chat`'s Start voice sat on "loading
 * models" because the Smart Turn worker's pre-bundled onnxruntime chunk no longer matched
 * transformers.js's (Vite re-optimised mid-session). `failed` builds each protocol's own
 * load-error message, which every driver already turns into a rejected `load()`.
 */
export interface WorkerPortOf<Request, Response> {
  post(message: Request, transfer?: readonly Transferable[]): void;
  onMessage(listener: (message: Response) => void): () => void;
  terminate(): void;
}

/** The slice of `Worker` this uses, so a test can hand over an `EventTarget`. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}

export function workerPort<Request, Response>(worker: WorkerLike, name: string, failed: (message: string) => Response): WorkerPortOf<Request, Response> {
  return {
    post(message, transfer = []) {
      worker.postMessage(message, [...transfer]);
    },
    onMessage(listener) {
      const onMessage = (event: Event): void => listener((event as MessageEvent<Response>).data);
      const onError = (event: Event): void => {
        const detail = (event as ErrorEvent).message;
        event.preventDefault();
        listener(
          failed(
            detail === undefined || detail === ''
              ? `the ${name} worker failed to start — a script it imports did not load (in development, restart the dev server with --force and reload)`
              : `the ${name} worker stopped: ${detail}`,
          ),
        );
      };
      const onMessageError = (): void => listener(failed(`the ${name} worker sent a message that could not be read`));
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onMessageError);
      return () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onMessageError);
      };
    },
    terminate() {
      worker.terminate();
    },
  };
}
