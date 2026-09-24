import * as ort from 'onnxruntime-web';
import type { OrtSessionLike } from '../turn/silero';
import {
  DISTILL_WINDOW_SAMPLES,
  BASE_MAX_SECONDS,
  SER_SAMPLE_RATE,
  classifyFrames,
  distillWindows,
  poseProbabilities,
  poseWeights,
  type LinearHead,
  type SerBackend,
} from './messages';

/**
 * The two voice-emotion models on onnxruntime-web, without a worker around them (P3-T05).
 * Each returns probabilities over `BASE_LABELS`; `messages.ts` holds the arithmetic and its
 * tests, this file only runs the graphs. The graphs' input and output names were read from
 * the files on 2026-09-24 and are asserted rather than trusted.
 */

export interface SerResult {
  readonly probabilities: number[];
  readonly inferenceMs: number;
  readonly seconds: number;
}

export interface SerModelLike {
  classify(samples: Float32Array): Promise<SerResult>;
}

/** emotion2vec+ base: any length in, `[1, frames, 768]` out, pooled and classified here. */
export class BaseSerModel implements SerModelLike {
  private readonly session: OrtSessionLike & { readonly inputNames: readonly string[]; readonly outputNames: readonly string[] };
  private readonly head: LinearHead;

  constructor(session: BaseSerModel['session'], head: LinearHead) {
    this.session = session;
    this.head = head;
  }

  async classify(samples: Float32Array): Promise<SerResult> {
    const max = BASE_MAX_SECONDS * SER_SAMPLE_RATE;
    const input = samples.length > max ? samples.slice(samples.length - max) : samples;
    const started = performance.now();
    const outputs = await this.session.run({ [this.session.inputNames[0] ?? 'input']: new ort.Tensor('float32', input, [1, input.length]) });
    const inferenceMs = performance.now() - started;
    const features = outputs[this.session.outputNames[0] ?? 'output'];
    const dims = features?.dims ?? [];
    if (features === undefined || dims.length !== 3 || dims[2] !== 768) {
      throw new Error(`emotion2vec returned ${JSON.stringify(dims)}; expected [1, frames, 768]`);
    }
    const frames = dims[1] ?? 0;
    return { probabilities: classifyFrames(features.data as Float32Array, frames, 768, this.head), inferenceMs, seconds: input.length / SER_SAMPLE_RATE };
  }
}

/** The distill: `waveform [windows, 48000]` in, `cosines [windows, 18]` out. */
export class DistillSerModel implements SerModelLike {
  private readonly session: OrtSessionLike;

  constructor(session: OrtSessionLike) {
    this.session = session;
  }

  async classify(samples: Float32Array): Promise<SerResult> {
    const { data, windows } = distillWindows(samples);
    const started = performance.now();
    const outputs = await this.session.run({ waveform: new ort.Tensor('float32', data, [windows, DISTILL_WINDOW_SAMPLES]) });
    const inferenceMs = performance.now() - started;
    const cosines = outputs['cosines'];
    if (cosines === undefined || cosines.dims[1] !== 18) throw new Error(`the distill returned ${JSON.stringify(cosines?.dims)}; expected [windows, 18]`);
    return {
      probabilities: poseProbabilities(poseWeights(cosines.data as Float32Array, windows)),
      inferenceMs,
      seconds: Math.min(samples.length, data.length) / SER_SAMPLE_RATE,
    };
  }
}

export async function createSerSession(bytes: Uint8Array, backend: SerBackend): Promise<ort.InferenceSession> {
  ort.env.wasm.numThreads = 1;
  return ort.InferenceSession.create(bytes, { executionProviders: [backend] });
}
