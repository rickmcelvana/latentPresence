import { describe, expect, it, vi } from 'vitest';
import type { FaceRequest, FaceResponse, FaceWorkerPort } from '@latentpresence/ml-web';
import { FaceExpressionReader } from './face-expression';

/** A worker that loads on the delegates in `works` and answers every frame with a smile. */
function fakeWorker(works: readonly string[]) {
  const made: { port: FaceWorkerPort; posts: FaceRequest[]; transfers: (readonly Transferable[] | undefined)[]; terminate: ReturnType<typeof vi.fn> }[] = [];
  const createWorker = (): FaceWorkerPort => {
    let listener: ((message: FaceResponse) => void) | null = null;
    const posts: FaceRequest[] = [];
    const transfers: (readonly Transferable[] | undefined)[] = [];
    const terminate = vi.fn();
    const port: FaceWorkerPort = {
      post(message, transfer) {
        posts.push(message);
        transfers.push(transfer);
        queueMicrotask(() => {
          if (message.type === 'load') {
            listener?.(
              works.includes(message.delegate)
                ? { type: 'ready', loadMs: 5, delegate: message.delegate }
                : { type: 'error', requestId: null, message: `${message.delegate} unavailable` },
            );
          } else {
            listener?.({ type: 'result', requestId: message.requestId, blendshapes: { mouthSmileLeft: 0.8 }, inferenceMs: 7 });
          }
        });
      },
      onMessage(next) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      terminate,
    };
    made.push({ port, posts, transfers, terminate });
    return port;
  };
  return { createWorker, made };
}

function bitmap(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

describe('FaceExpressionReader (P3-T06)', () => {
  it('loads on the GPU when it can', async () => {
    const { createWorker, made } = fakeWorker(['GPU', 'CPU']);
    await expect(new FaceExpressionReader({ createWorker }).load()).resolves.toBe('GPU');
    expect(made).toHaveLength(1);
  });

  it('falls back to the CPU in a fresh worker, and ends the failed one', async () => {
    const { createWorker, made } = fakeWorker(['CPU']);
    await expect(new FaceExpressionReader({ createWorker }).load()).resolves.toBe('CPU');
    expect(made).toHaveLength(2);
    expect(made[0]?.terminate).toHaveBeenCalled();
    expect(made[1]?.terminate).not.toHaveBeenCalled();
  });

  it('says why when no delegate loads', async () => {
    const { createWorker } = fakeWorker([]);
    await expect(new FaceExpressionReader({ createWorker }).load()).rejects.toThrow(/GPU unavailable.*CPU unavailable/u);
  });

  it('transfers each frame rather than copying it, and returns its blendshapes', async () => {
    const { createWorker, made } = fakeWorker(['GPU']);
    const reader = new FaceExpressionReader({ createWorker });
    const frame = bitmap();
    await expect(reader.read(frame, 100)).resolves.toEqual({ blendshapes: { mouthSmileLeft: 0.8 }, inferenceMs: 7 });
    expect(made[0]?.posts.at(-1)).toMatchObject({ type: 'frame', timestamp: 100 });
    expect(made[0]?.transfers.at(-1)).toEqual([frame]);
  });

  it('closes a frame it can no longer send, and rejects what was in flight on terminate', async () => {
    const { createWorker, made } = fakeWorker(['GPU']);
    const reader = new FaceExpressionReader({ createWorker });
    await reader.load();
    reader.terminate();
    expect(made[0]?.terminate).toHaveBeenCalled();
    const late = bitmap();
    await expect(reader.read(late, 1)).rejects.toThrow('stopped');
    expect(late.close).toHaveBeenCalled();
  });
});
