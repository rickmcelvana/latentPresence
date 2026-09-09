/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web';
import { FRAME_SAMPLES, SAMPLE_RATE } from './frames';
import { TURN_WINDOW_SAMPLES } from './turn-audio';

/**
 * Silero VAD, run directly on onnxruntime-web.
 *
 * Not `@ricky0123/vad-web`: that brings a second ONNX Runtime alongside the one
 * transformers.js pins, ~91 MB of package for a 2 MB model (docs/SURFACE.md).
 *
 * The graph signature was read out of the model file itself: inputs `input`, `sr`,
 * `state`; outputs `output`, `stateN`. The recurrent state is carried from one call to
 * the next by feeding `stateN` straight back in, so only its initial shape is assumed
 * here — and the worker reports the shape it actually saw, so the write-up records what
 * was true rather than what was expected.
 */

const MODEL_URL =
  'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx';

/** Enter speech above this, leave below the lower one. Hysteresis stops chattering. */
const SPEECH_ON = 0.5;
const SPEECH_OFF = 0.35;

/**
 * Silence tolerated before an utterance is closed. Reported separately from latency:
 * it is a tuning choice, not a cost of the pipeline (P0-T07 exists to shrink it).
 */
const DEFAULT_HANGOVER_MS = 500;

/**
 * How long the hangover actually waits, and whether a short silence should be offered to
 * a semantic endpointer on the way. Both are set at load time and both default to Spike
 * A's behaviour, so its measurements stay reproducible while Spike D reuses the worker.
 */
let hangoverMs = DEFAULT_HANGOVER_MS;
let candidateMs: number | null = null;

/**
 * Audio kept from before speech was detected. Silero needs a frame or two to be sure,
 * and without a pre-roll the recogniser loses the start of the first word.
 */
const PREROLL_MS = 300;

/**
 * What was actually captured. Duration against sample count is the fastest way to catch a
 * resampling mistake: two seconds of speech is 32000 samples at 16 kHz and 96000 at
 * 48 kHz, and a recogniser fed the wrong rate returns fluent nonsense rather than an error.
 */
interface UtteranceStats {
  readonly sampleCount: number;
  readonly durationMs: number;
  readonly rms: number;
  readonly peak: number;
  readonly maxProbability: number;
}

/**
 * Level and duration of one buffer, for telling speech from the room it was recorded in.
 *
 * `highestProbability` is passed rather than read from module scope: it is the only field
 * that is not a property of the samples, and hiding that would make the stats look more
 * self-contained than they are.
 */
function statsFor(samples: Float32Array, highestProbability: number): UtteranceStats {
  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return {
    sampleCount: samples.length,
    durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
    rms: Math.sqrt(sumSquares / Math.max(1, samples.length)),
    peak,
    maxProbability: highestProbability,
  };
}

type InboundMessage =
  | {
      readonly type: 'load';
      /** Defaults to 500 ms — Spike A's value. */
      readonly hangoverMs?: number;
      /**
       * Silence after which the utterance so far is offered as a `candidate`, without
       * closing it. Omitted means no candidates at all, which is Spike A exactly.
       */
      readonly candidateMs?: number;
    }
  | { readonly type: 'frame'; readonly samples: Float32Array; readonly at: number }
  /**
   * Something downstream decided this turn is over before the hangover expired — Smart
   * Turn v3 firing on a candidate. The utterance is dropped without a `settled`, so the
   * next word starts a new turn rather than joining the one just answered.
   */
  | { readonly type: 'end-turn'; readonly turnId: number }
  | { readonly type: 'reset' };

type OutboundMessage =
  | { readonly type: 'ready'; readonly stateDims: readonly number[] }
  | { readonly type: 'speech-start'; readonly at: number; readonly turnId: number }
  | { readonly type: 'speech-end'; readonly at: number; readonly turnId: number }
  /**
   * A short silence, offered for a second opinion. The turn is still open: if nothing
   * acts on this, speech may resume or the hangover will close it as usual.
   */
  | {
      readonly type: 'candidate';
      readonly at: number;
      readonly turnId: number;
      readonly samples: Float32Array;
      readonly speechEndAt: number;
      /**
       * What the VAD thought it heard. Carried because the 2026-09-08 run produced
       * twenty-one turns where twenty were spoken, and nothing in the record could say
       * which one was the room rather than the person — a bell, a chair, a door. A short
       * window with a high peak and a middling `maxProbability` looks nothing like a
       * sentence, but only if the numbers were kept.
       */
      readonly stats: UtteranceStats;
    }
  | {
      readonly type: 'settled';
      readonly at: number;
      readonly turnId: number;
      readonly samples: Float32Array;
      readonly speechStartAt: number;
      readonly speechEndAt: number;
      /**
       * What was actually captured. Duration against sample count is the fastest way to
       * catch a resampling mistake: two seconds of speech is 32000 samples at 16 kHz and
       * 96000 at 48 kHz, and a recogniser fed the wrong rate returns fluent nonsense
       * rather than an error.
       */
      readonly stats: UtteranceStats;
    }
  | { readonly type: 'error'; readonly message: string };

function post(message: OutboundMessage, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

let session: ort.InferenceSession | null = null;
let state: ort.Tensor | null = null;

/** Frames of the current utterance, plus the pre-roll that came before it. */
let utterance: Float32Array[] = [];
let preroll: Float32Array[] = [];
const prerollFrames = Math.ceil((PREROLL_MS / 1000) * (SAMPLE_RATE / FRAME_SAMPLES));

let speaking = false;
/**
 * Whether the current run of silence has already been offered as a candidate. One per
 * pause, not one per frame: without it a 400 ms gap at 32 ms frames would ask the model
 * a dozen times and the timings would measure a queue.
 */
let candidateOffered = false;
let speechStartAt = 0;
/** When speech last stopped — the honest end of the utterance, before the hangover. */
let lastSpeechAt = 0;
/** Highest Silero score in the current utterance, so a marginal detection is visible. */
let maxProbability = 0;
/**
 * Identifies the utterance. A turn's recognition and synthesis outlive the next
 * utterance starting — someone speaks again while the answer is still playing — so every
 * mark has to say which turn it belongs to or two turns share one set and both are lost.
 */
let turnId = 0;

function freshState(): ort.Tensor {
  // Silero v5 carries one unified state of [2, 1, 128]; earlier versions used separate
  // h and c. If this shape is wrong the first inference throws rather than misbehaving
  // quietly, which is why it is not defended against here.
  return new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
}

function resetUtterance(): void {
  utterance = [];
  preroll = [];
  speaking = false;
  candidateOffered = false;
  maxProbability = 0;
  state = freshState();
}

/**
 * The utterance so far as one buffer, optionally only its last `limit` samples.
 *
 * Candidates are capped at the model's 8 s window: someone talking for a minute would
 * otherwise post a megabyte down the port several times a turn, to be thrown away by the
 * truncation on the other side.
 */
function collectUtterance(limit?: number): Float32Array {
  const total = utterance.reduce((sum, frame) => sum + frame.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const frame of utterance) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  if (limit !== undefined && joined.length > limit) return joined.slice(joined.length - limit);
  return joined;
}

async function load(options: { hangoverMs?: number; candidateMs?: number }): Promise<void> {
  hangoverMs = options.hangoverMs ?? DEFAULT_HANGOVER_MS;
  candidateMs = options.candidateMs ?? null;
  ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ['wasm'],
  });
  state = freshState();
  post({ type: 'ready', stateDims: state.dims });
}

async function onFrame(samples: Float32Array, at: number): Promise<void> {
  if (session === null || state === null) return;

  const result = await session.run({
    input: new ort.Tensor('float32', samples, [1, samples.length]),
    sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    state,
  });

  const probability = (result['output'] as ort.Tensor).data[0] as number;
  state = result['stateN'] as ort.Tensor;
  if (probability > maxProbability) maxProbability = probability;

  if (!speaking) {
    preroll.push(samples);
    if (preroll.length > prerollFrames) preroll.shift();
  } else {
    utterance.push(samples);
  }

  if (!speaking && probability >= SPEECH_ON) {
    speaking = true;
    turnId += 1;
    speechStartAt = at;
    lastSpeechAt = at;
    // The pre-roll becomes the head of the utterance, so the first word survives.
    utterance = [...preroll];
    preroll = [];
    post({ type: 'speech-start', at, turnId });
    return;
  }

  if (speaking) {
    if (probability >= SPEECH_OFF) {
      lastSpeechAt = at;
      // Speech came back, so the next pause deserves its own candidate.
      candidateOffered = false;
      return;
    }

    const silenceMs = at - lastSpeechAt;

    if (candidateMs !== null && !candidateOffered && silenceMs >= candidateMs) {
      candidateOffered = true;
      const window = collectUtterance(TURN_WINDOW_SAMPLES);
      post(
        {
          type: 'candidate',
          at,
          turnId,
          samples: window,
          speechEndAt: lastSpeechAt,
          stats: statsFor(window, maxProbability),
        },
        [window.buffer],
      );
    }

    if (silenceMs < hangoverMs) return;

    // The hangover expired. `speechEndAt` is when speech actually stopped, not now:
    // conflating the two would charge the pipeline for a tuning constant.
    const joined = collectUtterance();
    const stats = statsFor(joined, maxProbability);

    post({ type: 'speech-end', at: lastSpeechAt, turnId });
    post(
      {
        type: 'settled',
        at,
        turnId,
        samples: joined,
        speechStartAt,
        speechEndAt: lastSpeechAt,
        stats,
      },
      [joined.buffer],
    );
    resetUtterance();
  }
}

self.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === 'load') await load(message);
      else if (message.type === 'frame') await onFrame(message.samples, message.at);
      else if (message.type === 'end-turn') {
        // Only if it is still the turn in flight. A late arrival for a turn the hangover
        // already closed must not wipe the one that started since.
        if (speaking && message.turnId === turnId) resetUtterance();
      } else resetUtterance();
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  })();
});
