import type { TurnJudge } from '@latentpresence/core';
import {
  TURN_WINDOW_SAMPLES,
  smartTurnCombinationBlocker,
  type SmartTurnBackend,
  type SmartTurnBuild,
  type SmartTurnResponse,
  type SmartTurnWorkerPort,
} from '@latentpresence/ml-web';
import type { CancellationSignal } from '@latentpresence/protocol';
import { isAborted } from '../stt/signal';

/**
 * Smart Turn v3 as `TurnDetector`'s judge, driven through a worker (P1-T07).
 *
 * The model is in `packages/ml-web`, the endpointing logic in `packages/core`; this is
 * the conversation with the worker, testable in node against a fake port.
 *
 * **Defaults are ADR-21's: the fp32 build on WebGPU.** int8 on WebGPU is refused at
 * construction — it does not load there — so a settings screen can say so while the user
 * is still choosing, rather than the first pause of the first conversation finding out.
 */
export interface SmartTurnJudgeConfig {
  readonly createWorker: () => SmartTurnWorkerPort;
  readonly build?: SmartTurnBuild;
  readonly backend?: SmartTurnBackend;
  /** Every answer's cost, for the latency badges P1-T11 shows. */
  readonly onMeasured?: (measurement: {
    readonly probability: number;
    readonly featuresMs: number;
    readonly inferenceMs: number;
  }) => void;
}

interface Pending {
  resolve(probability: number): void;
  reject(error: Error): void;
}

export class SmartTurnJudge implements TurnJudge {
  readonly build: SmartTurnBuild;
  readonly backend: SmartTurnBackend;
  private readonly config: SmartTurnJudgeConfig;
  private port: SmartTurnWorkerPort | null = null;
  private detach: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly loadListeners = new Set<(message: SmartTurnResponse) => void>();
  private nextRequestId = 0;

  constructor(config: SmartTurnJudgeConfig) {
    this.build = config.build ?? 'gpu';
    this.backend = config.backend ?? 'webgpu';
    const blocker = smartTurnCombinationBlocker(this.backend, this.build);
    if (blocker !== null) throw new Error(`smart-turn: ${blocker}`);
    this.config = config;
  }

  /**
   * Load the model. Call it when the session starts: a judge that loads on the first
   * candidate spends Spike D's ~1 s of load inside the first turn, and that answer arrives
   * after the hangover as `late`.
   */
  async load(): Promise<void> {
    await this.ready();
  }

  async judge(audio: Float32Array, signal: CancellationSignal): Promise<number> {
    if (isAborted(signal)) throw new Error('smart-turn: cancelled');
    const port = await this.ready();
    if (isAborted(signal)) throw new Error('smart-turn: cancelled');

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    // The model reads the last 8 s and nothing else, so only that crosses the port. A
    // copy, never the caller's buffer: recognition was handed the same one (ADR-21), and
    // transferring it would detach it from under the recogniser.
    const samples = audio.slice(Math.max(0, audio.length - TURN_WINDOW_SAMPLES));

    return new Promise<number>((resolve, reject) => {
      const cancel = (): void => port.post({ type: 'cancel', requestId });
      signal.addEventListener('abort', cancel);
      const settle = (): void => {
        signal.removeEventListener('abort', cancel);
        this.pending.delete(requestId);
      };
      this.pending.set(requestId, {
        resolve: (probability) => {
          settle();
          resolve(probability);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      port.post({ type: 'judge', requestId, samples }, [samples.buffer]);
    });
  }

  /** Stop the worker and fail anything outstanding. The next call loads a new one. */
  terminate(): void {
    this.failAll(new Error('smart-turn: terminated'));
    this.detach?.();
    this.port?.terminate();
    this.detach = null;
    this.port = null;
    this.loading = null;
  }

  private onMessage(message: SmartTurnResponse): void {
    for (const listener of Array.from(this.loadListeners)) listener(message);
    if (message.type === 'ready') return;
    if (message.type === 'error' && message.requestId === null) {
      this.failAll(new Error(`smart-turn: ${message.message}`));
      return;
    }
    const requestId = message.requestId;
    // A null id is a worker-level failure, which never belongs to one request.
    const pending = requestId === null ? undefined : this.pending.get(requestId);
    if (pending === undefined) return;
    if (message.type === 'probability') {
      this.config.onMeasured?.({
        probability: message.probability,
        featuresMs: message.featuresMs,
        inferenceMs: message.inferenceMs,
      });
      pending.resolve(message.probability);
    } else if (message.type === 'cancelled') {
      pending.reject(new Error('smart-turn: cancelled'));
    } else {
      pending.reject(new Error(`smart-turn: ${message.message}`));
    }
  }

  private failAll(error: Error): void {
    for (const pending of Array.from(this.pending.values())) pending.reject(error);
  }

  /** Single-flight: two candidates arriving before load finishes load once. */
  private async ready(): Promise<SmartTurnWorkerPort> {
    if (this.port === null) {
      const port = this.config.createWorker();
      this.port = port;
      this.detach = port.onMessage((message) => this.onMessage(message));
    }
    const port = this.port;

    this.loading ??= new Promise<void>((resolve, reject) => {
      const listener = (message: SmartTurnResponse): void => {
        if (message.type === 'ready') {
          this.loadListeners.delete(listener);
          resolve();
        } else if (message.type === 'error' && message.requestId === null) {
          this.loadListeners.delete(listener);
          // Not cached as a failure for ever: consent can be granted and load retried.
          this.loading = null;
          reject(new Error(`smart-turn: ${message.message}`));
        }
      };
      this.loadListeners.add(listener);
      port.post({ type: 'load', build: this.build, backend: this.backend });
    });

    await this.loading;
    return port;
  }
}
