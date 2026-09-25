import type { Blendshapes, FaceDelegate, FaceResponse, FaceWorkerPort } from '@latentpresence/ml-web';

/**
 * The user's face, frame by frame, through a worker (P3-T06). The landmarker is in
 * `packages/ml-web/src/face`, the reading is `FaceAffectReader` in core, fusion is P3-T07's;
 * this is the conversation with the worker, testable in node against a fake port.
 *
 * The GPU delegate is tried first and the CPU one if it fails to load — a worker's WebGL
 * comes from an `OffscreenCanvas`, which not every browser gives a worker. Each attempt is
 * a fresh worker, so a half-initialised GPU graph never lingers.
 */

export interface FaceFrameResult {
  /** Null when there is no face in the frame. */
  readonly blendshapes: Blendshapes | null;
  readonly inferenceMs: number;
}

export interface FaceExpressionConfig {
  readonly createWorker: () => FaceWorkerPort;
  /** Delegates to try, in order. */
  readonly delegates?: readonly FaceDelegate[];
}

interface Pending {
  resolve(result: FaceFrameResult): void;
  reject(error: Error): void;
}

export class FaceExpressionReader {
  private readonly config: FaceExpressionConfig;
  private port: FaceWorkerPort | null = null;
  private detach: (() => void) | null = null;
  private loading: Promise<FaceDelegate> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 0;
  private terminated = false;

  constructor(config: FaceExpressionConfig) {
    this.config = config;
  }

  /** Start the worker and load the landmarker; resolves with the delegate that loaded. */
  load(): Promise<FaceDelegate> {
    this.loading ??= this.loadFirst(this.config.delegates ?? ['GPU', 'CPU']);
    return this.loading;
  }

  /**
   * One camera frame. **The bitmap is transferred**: after this call the caller's copy is
   * detached, and the worker closes it once read — so no frame is held on either side.
   */
  async read(frame: ImageBitmap, timestamp: number): Promise<FaceFrameResult> {
    await this.load();
    const port = this.port;
    if (port === null) {
      frame.close();
      throw new Error('face reading: stopped');
    }
    const requestId = (this.nextRequestId += 1);
    return new Promise<FaceFrameResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      port.post({ type: 'frame', requestId, frame, timestamp }, [frame]);
    });
  }

  terminate(): void {
    this.terminated = true;
    this.stopPort();
    for (const pending of this.pending.values()) pending.reject(new Error('face reading: stopped'));
    this.pending.clear();
  }

  private async loadFirst(delegates: readonly FaceDelegate[]): Promise<FaceDelegate> {
    const failures: string[] = [];
    for (const delegate of delegates) {
      if (this.terminated) break;
      try {
        await this.loadWith(delegate);
        return delegate;
      } catch (error) {
        failures.push(`${delegate}: ${error instanceof Error ? error.message : String(error)}`);
        this.stopPort();
      }
    }
    throw new Error(`face reading: ${this.terminated ? 'stopped' : failures.join('; ')}`);
  }

  private loadWith(delegate: FaceDelegate): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const port = this.config.createWorker();
      this.port = port;
      this.detach = port.onMessage((message) => {
        if (message.type === 'ready') resolve();
        else if (message.type === 'error' && message.requestId === null) reject(new Error(message.message));
        else this.receive(message);
      });
      port.post({ type: 'load', delegate });
    });
  }

  private stopPort(): void {
    this.detach?.();
    this.detach = null;
    this.port?.terminate();
    this.port = null;
  }

  private receive(message: FaceResponse): void {
    if (message.type === 'ready' || message.requestId === null) return;
    const pending = this.pending.get(message.requestId);
    if (pending === undefined) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') pending.reject(new Error(`face reading: ${message.message}`));
    else pending.resolve({ blendshapes: message.blendshapes, inferenceMs: message.inferenceMs });
  }
}
