import { WhisperFeatureExtractor } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web';
import type { SmartTurnBackend } from './messages';
import { TURN_MODEL_SAMPLE_RATE } from './messages';
import type { OrtSessionLike } from './silero';
import { TURN_WINDOW_SAMPLES, featureSpanIsPlausible, prepareTurnWindow } from './turn-audio';

/**
 * Smart Turn v3 on onnxruntime-web, without a worker around it (P1-T07).
 *
 * Promoted from Spike D's worker. The graph signature and preprocessing were read out of
 * the model files and pipecat's `inference.py` on 2026-09-08 (`docs/SURFACE.md`, "Smart
 * Turn v3 input surface"): `input_features` float32 `[batch, 80, 800]` in, `logits`
 * float32 `[batch, 1]` out, already sigmoid-activated despite the name.
 */

const MEL_BINS = 80;
const MEL_FRAMES = 800;

/**
 * `WhisperFeatureExtractor(chunk_length=8)` spelled out: transformers.js has no
 * `from_pretrained` we could use without fetching a `preprocessor_config.json` from the
 * hub, which would be a download the consent screen had not declared.
 */
export const SMART_TURN_EXTRACTOR_CONFIG = {
  feature_size: MEL_BINS,
  sampling_rate: TURN_MODEL_SAMPLE_RATE,
  hop_length: 160,
  chunk_length: 8,
  n_fft: 400,
  n_samples: TURN_WINDOW_SAMPLES,
  nb_max_frames: MEL_FRAMES,
  padding_value: 0,
} as const;

export interface SmartTurnJudgement {
  readonly probability: number;
  readonly featuresMs: number;
  readonly inferenceMs: number;
}

export class SmartTurnModel {
  private readonly session: OrtSessionLike;
  // Pure JS, built from the config above: the mel filterbank is computed here and nothing
  // is fetched.
  private readonly extractor = new WhisperFeatureExtractor(SMART_TURN_EXTRACTOR_CONFIG);

  constructor(session: OrtSessionLike) {
    this.session = session;
  }

  /**
   * p(the utterance is finished). Takes any length of 16 kHz audio and uses the last 8 s.
   *
   * **Refuses rather than answers** when the feature block is not a Whisper log-mel:
   * the model scores a malformed window with a confident number, not an error, so a wrong
   * extractor would otherwise read as a result. The check is cheap enough to run on
   * every call, which is the point — it checks the machine taking the measurement.
   */
  async judge(samples: Float32Array): Promise<SmartTurnJudgement> {
    const featuresStartedAt = performance.now();
    // `_call` rather than calling the instance: the callable form is typed `any`, and a
    // cast is exactly how a wrong feature block would get through.
    // eslint-disable-next-line no-underscore-dangle
    const { input_features } = await this.extractor._call(prepareTurnWindow(samples));
    const featuresMs = performance.now() - featuresStartedAt;

    const data = input_features.data as Float32Array;
    const dims = [...input_features.dims];
    if (dims.length !== 3 || dims[1] !== MEL_BINS || dims[2] !== MEL_FRAMES || !featureSpanIsPlausible(data)) {
      throw new Error(`feature block ${JSON.stringify(dims)} is not an 80x800 Whisper log-mel; refusing to score it`);
    }

    const inferenceStartedAt = performance.now();
    const outputs = await this.session.run({
      input_features: new ort.Tensor('float32', data, [1, MEL_BINS, MEL_FRAMES]),
    });
    const inferenceMs = performance.now() - inferenceStartedAt;

    const probability = outputs['logits']?.data[0];
    // Named `logits`, holds a probability: the graph ends in a Sigmoid. Asserted rather
    // than trusted either way (`docs/SURFACE.md`).
    if (typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) {
      throw new Error(`Smart Turn returned ${String(probability)} as "logits"; expected a probability`);
    }
    return { probability, featuresMs, inferenceMs };
  }
}

/** Load a Smart Turn build on an explicit backend. Callers check the combination first. */
export async function createSmartTurnSession(
  source: string | Uint8Array,
  backend: SmartTurnBackend,
): Promise<ort.InferenceSession> {
  ort.env.wasm.numThreads = 1;
  return typeof source === 'string'
    ? ort.InferenceSession.create(source, { executionProviders: [backend] })
    : ort.InferenceSession.create(source, { executionProviders: [backend] });
}
