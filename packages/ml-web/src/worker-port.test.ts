import { describe, expect, it, vi } from 'vitest';
import { workerPort, type WorkerLike } from './worker-port';

type Out = { type: 'ready' } | { type: 'error'; requestId: null; message: string };

/** An `EventTarget` standing in for a `Worker`. */
function fakeWorker(): WorkerLike & { fire(type: string, init?: Record<string, unknown>): void; posted: unknown[] } {
  const target = new EventTarget();
  const posted: unknown[] = [];
  return {
    posted,
    postMessage: (message) => posted.push(message),
    addEventListener: (type, listener) => target.addEventListener(type, listener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    terminate: vi.fn(),
    fire(type, init = {}) {
      const event = Object.assign(new Event(type, { cancelable: true }), init);
      target.dispatchEvent(event);
    },
  };
}

const failed = (message: string): Out => ({ type: 'error', requestId: null, message });

describe('workerPort', () => {
  it('passes messages through', () => {
    const worker = fakeWorker();
    const seen: Out[] = [];
    workerPort<string, Out>(worker, 'test', failed).onMessage((message) => seen.push(message));
    worker.fire('message', { data: { type: 'ready' } });
    expect(seen).toEqual([{ type: 'ready' }]);
  });

  it('turns a worker that died without a word into a load error, instead of silence', () => {
    const worker = fakeWorker();
    const seen: Out[] = [];
    workerPort<string, Out>(worker, 'Smart Turn', failed).onMessage((message) => seen.push(message));
    // What Chrome fires when a module worker's import fails: an ErrorEvent with no message.
    worker.fire('error', { message: '' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'error', requestId: null });
    expect((seen[0] as { message: string }).message).toContain('the Smart Turn worker failed to start');
  });

  it('says what a runtime error said, and stops listening when asked', () => {
    const worker = fakeWorker();
    const seen: Out[] = [];
    const detach = workerPort<string, Out>(worker, 'face', failed).onMessage((message) => seen.push(message));
    worker.fire('error', { message: 'out of memory' });
    detach();
    worker.fire('error', { message: 'again' });
    worker.fire('message', { data: { type: 'ready' } });
    expect(seen).toEqual([{ type: 'error', requestId: null, message: 'the face worker stopped: out of memory' }]);
  });
});
