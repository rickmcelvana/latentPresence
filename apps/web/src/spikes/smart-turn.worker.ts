/// <reference lib="webworker" />
import { WhisperFeatureExtractor } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web';
import { TURN_WINDOW_SAMPLES, featureSpanIsPlausible, prepareTurnWindow } from './turn-audio';
import { SAMPLE_RATE } from './frames';

/**
 * Smart Turn v3 on onnxruntime-web: does the sentence sound finished?
 *
 * The graph signature and the preprocessing were read out of the model files and
 * pipecat's `inference.py` on 2026-09-08, not remembered — `docs/SURFACE.md`, "Smart Turn
 * v3 input surface". `input_features` float32 [batch, 80, 800] in, `logits` float32
 * [batch, 1] out, already sigmoid-activated despite the name.
 *
 * No time here is comparable with the page's clock: a dedicated worker has its own
 * `performance.timeOrigin`. So this worker reports *durations* only, and the page stamps
 * the arrival on the one clock that measures the whole pipeline. Spike A established that
 * and it is the reason its numbers are trustworthy.
 */

const MODELS = {
  // int8. The cheap download, and the one Spike A's q8 finding says to distrust on WebGPU.
  cpu: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx',
  // fp32, straight from PyTorch.
  gpu: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-gpu.onnx',
} as const;

export type SmartTurnBuild = keyof typeof MODELS;
export type SmartTurnBackend = 'webgpu' | 'wasm';

/** 80 mel bins by 800 frames, from the graph itself. */
const MEL_BINS = 80;
const MEL_FRAMES = 800;

/**
 * `WhisperFeatureExtractor(chunk_length=8)` spelled out, because transformers.js has no
 * `from_pretrained` shortcut we could use without fetching a `preprocessor_config.json`
 * from the hub — which would be a download before the consent screen had said so.
 *
 * `nb_max_frames` is `n_samples / hop_length`. Python computes 801 STFT frames and drops
 * the last; the JS caps at this. Same 800 frames.
 */
const EXTRACTOR_CONFIG = {
  feature_size: MEL_BINS,
  sampling_rate: SAMPLE_RATE,
  hop_length: 160,
  chunk_length: 8,
  n_fft: 400,
  n_samples: TURN_WINDOW_SAMPLES,
  nb_max_frames: MEL_FRAMES,
  padding_value: 0,
} as const;

type InboundMessage =
  | { readonly type: 'load'; readonly build: SmartTurnBuild; readonly backend: SmartTurnBackend }
  | {
      readonly type: 'infer';
      readonly samples: Float32Array;
      readonly turnId: number;
      readonly candidateIndex: number;
    };

type OutboundMessage =
  | {
      readonly type: 'ready';
      readonly loadMs: number;
      readonly build: SmartTurnBuild;
      readonly backend: SmartTurnBackend;
      /**
       * Whether WebGPU exists at all in this worker. onnxruntime-web can fall back to
       * wasm without saying so, and Spike A's rule is to report that rather than print
       * the wasm number twice under a GPU heading.
       */
      readonly webgpuAvailable: boolean;
      readonly inputNames: readonly string[];
      readonly outputNames: readonly string[];
    }
  | {
      readonly type: 'probability';
      readonly turnId: number;
      readonly candidateIndex: number;
      readonly probability: number;
      /** Feature extraction alone, on this worker's clock. */
      readonly featuresMs: number;
      /** `session.run` alone. */
      readonly inferenceMs: number;
      /** What the extractor actually produced, not what it was asked for. */
      readonly featureDims: readonly number[];
      /**
       * Whether the feature block spans the 2.0 that Whisper's final clamp guarantees.
       * False means the numbers downstream are not a log-mel and the probability is
       * meaningless, however plausible it looks.
       */
      readonly featuresPlausible: boolean;
    }
  | { readonly type: 'error'; readonly message: string; readonly turnId?: number };

function post(message: OutboundMessage): void {
  (self as unknown as Worker).postMessage(message);
}

let session: ort.InferenceSession | null = null;
let extractor: WhisperFeatureExtractor | null = null;

async function load(build: SmartTurnBuild, backend: SmartTurnBackend): Promise<void> {
  const startedAt = performance.now();

  ort.env.wasm.numThreads = 1;
  // The extractor is pure JS and constructed from the config above, so this costs
  // nothing and fetches nothing; the mel filterbank is computed in the constructor.
  extractor = new WhisperFeatureExtractor(EXTRACTOR_CONFIG);
  session = await ort.InferenceSession.create(MODELS[build], {
    executionProviders: [backend],
  });

  post({
    type: 'ready',
    loadMs: performance.now() - startedAt,
    build,
    backend,
    webgpuAvailable: 'gpu' in navigator,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
  });
}

async function infer(samples: Float32Array, turnId: number, candidateIndex: number): Promise<void> {
  if (session === null || extractor === null) {
    post({ type: 'error', message: 'inference before load', turnId });
    return;
  }

  const featuresStartedAt = performance.now();
  // `_call` rather than calling the instance. transformers.js makes feature extractors
  // callable through a `Callable` base whose call signature is `(...args: any[]) => any`,
  // so `extractor(...)` would hand us an untyped result to cast — and a cast is exactly
  // how a wrong feature block would get through. `_call` is the same code, typed.
  // eslint-disable-next-line no-underscore-dangle
  const { input_features } = await extractor._call(prepareTurnWindow(samples));
  const featuresMs = performance.now() - featuresStartedAt;

  const data = input_features.data as Float32Array;
  const featureDims = [...input_features.dims];
  const featuresPlausible =
    featureDims.length === 3 &&
    featureDims[1] === MEL_BINS &&
    featureDims[2] === MEL_FRAMES &&
    featureSpanIsPlausible(data);

  const inferenceStartedAt = performance.now();
  const outputs = await session.run({
    input_features: new ort.Tensor('float32', data, [1, MEL_BINS, MEL_FRAMES]),
  });
  const inferenceMs = performance.now() - inferenceStartedAt;

  const output = outputs['logits'];
  if (output === undefined) {
    post({
      type: 'error',
      message: `no "logits" output; got ${session.outputNames.join(', ')}`,
      turnId,
    });
    return;
  }

  post({
    type: 'probability',
    turnId,
    candidateIndex,
    probability: output.data[0] as number,
    featuresMs,
    inferenceMs,
    featureDims,
    featuresPlausible,
  });
}

self.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === 'load') await load(message.build, message.backend);
      else await infer(message.samples, message.turnId, message.candidateIndex);
    } catch (error) {
      post({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        ...(message.type === 'infer' ? { turnId: message.turnId } : {}),
      });
    }
  })();
});
