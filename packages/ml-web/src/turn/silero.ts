import * as ort from 'onnxruntime-web';
import { TURN_MODEL_SAMPLE_RATE, VAD_CONTEXT_SAMPLES, VAD_FRAME_SAMPLES } from './messages';

/**
 * Silero VAD v5 on onnxruntime-web, without a worker around it (P1-T07).
 *
 * Kept apart from `vad.worker.ts` so the live check (`live/turn.ts`) runs this exact code
 * in node rather than a copy of it. Not `@ricky0123/vad-web`: that brings a second ONNX
 * Runtime beside the one transformers.js pins (`docs/SURFACE.md`).
 *
 * The graph signature was read out of the model: inputs `input`, `state`, `sr`; outputs
 * `output`, `stateN`, with the recurrent state `[2, 1, 128]` fed straight back in.
 */

/** The part of `ort.InferenceSession` used here, so a test can hand over a fake. */
export interface OrtSessionLike {
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor | undefined>>;
}

export interface SileroOptions {
  /**
   * Prepend the previous call's last 64 samples, as the reference wrapper does. Defaults
   * to true. False reproduces Spikes A and D, which fed the bare frame — kept only so the
   * live check can measure what the difference is.
   */
  readonly context?: boolean;
}

function freshState(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
}

export class SileroVad {
  private readonly session: OrtSessionLike;
  private readonly useContext: boolean;
  private state = freshState();
  private context = new Float32Array(VAD_CONTEXT_SAMPLES);
  private readonly sampleRate = new ort.Tensor('int64', BigInt64Array.from([BigInt(TURN_MODEL_SAMPLE_RATE)]), []);
  /**
   * Every call runs after the one before it. The state is recurrent: two frames run
   * concurrently would both read the same state and one frame's update would be lost.
   * Spike A's worker started each frame's `run` as its message arrived and relied on
   * inference being quicker than 32 ms — true on that machine, not a property of the code.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(session: OrtSessionLike, options: SileroOptions = {}) {
    this.session = session;
    this.useContext = options.context ?? true;
  }

  /** p(speech) for one 512-sample frame at 16 kHz. Calls resolve in the order made. */
  probability(frame: Float32Array): Promise<number> {
    if (frame.length !== VAD_FRAME_SAMPLES) {
      return Promise.reject(
        new Error(`Silero wants ${VAD_FRAME_SAMPLES} samples per frame at 16 kHz, got ${frame.length}`),
      );
    }
    // Copied now, not when the queue reaches it: the caller may transfer the buffer away
    // as soon as this returns.
    const input = this.useContext ? new Float32Array(VAD_CONTEXT_SAMPLES + VAD_FRAME_SAMPLES) : frame.slice();
    if (this.useContext) input.set(frame, VAD_CONTEXT_SAMPLES);

    const run = this.queue.then(() => this.run(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Forget the stream so far. Queued behind any frames already submitted. */
  reset(): Promise<void> {
    const done = this.queue.then(() => {
      this.state = freshState();
      this.context = new Float32Array(VAD_CONTEXT_SAMPLES);
    });
    this.queue = done;
    return done;
  }

  private async run(input: Float32Array): Promise<number> {
    if (this.useContext) input.set(this.context, 0);

    const result = await this.session.run({
      input: new ort.Tensor('float32', input, [1, input.length]),
      state: this.state,
      sr: this.sampleRate,
    });

    const output = result['output'];
    const stateN = result['stateN'];
    if (output === undefined || stateN === undefined) {
      throw new Error(`Silero returned ${Object.keys(result).join(', ')}; expected output and stateN`);
    }
    this.state = stateN;
    if (this.useContext) this.context = input.slice(input.length - VAD_CONTEXT_SAMPLES);

    const probability = output.data[0];
    if (typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) {
      throw new Error(`Silero returned ${String(probability)}, which is not a probability`);
    }
    return probability;
  }
}

/** Load Silero from a URL or bytes. wasm only: a 2 MB graph at 32 ms is not worth a GPU hop. */
export async function createSileroSession(source: string | Uint8Array): Promise<ort.InferenceSession> {
  ort.env.wasm.numThreads = 1;
  return typeof source === 'string'
    ? ort.InferenceSession.create(source, { executionProviders: ['wasm'] })
    : ort.InferenceSession.create(source, { executionProviders: ['wasm'] });
}
