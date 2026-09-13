import { TURN_MODEL_SAMPLE_RATE } from './messages';

/**
 * The waveform preparation Smart Turn v3 expects, before the log-mel.
 *
 * This is the part `WhisperFeatureExtractor` does *not* do, and the part where a mistake
 * is invisible. pipecat's `inference.py` wraps the extractor in two steps
 * (`docs/SURFACE.md`, "Smart Turn v3 input surface", 2026-09-08):
 *
 *   1. keep the last 8 s, zero-padding at the *front* when the audio is shorter;
 *   2. `do_normalize=True`, which is zero-mean unit-variance over the whole padded array.
 *
 * transformers.js pads at the *back* and has no `do_normalize` at all. Feed it a short
 * utterance directly and the speech sits at the wrong end of the window on a wrong scale,
 * and the model answers confidently anyway — the Spike A failure mode, where the numbers
 * look fine and mean nothing. Hence a module of its own, with tests.
 */

/** The model's window: `WhisperFeatureExtractor(chunk_length=8)`, so 8 s at 16 kHz. */
export const TURN_WINDOW_SECONDS = 8;

/** 128 000 samples. The extractor is handed exactly this many, never fewer. */
export const TURN_WINDOW_SAMPLES = TURN_WINDOW_SECONDS * TURN_MODEL_SAMPLE_RATE;

/**
 * Cut the model's window out of an utterance: the last 8 s, padded at the front.
 *
 * Front-padding is not cosmetic. The model is a turn *endpointer*; it was trained with
 * the end of speech against the end of the window, so padding at the back would hand it
 * a sentence that stops 6 s early — which is what "incomplete" looks like.
 */
export function windowForTurn(audio: Float32Array): Float32Array {
  if (audio.length >= TURN_WINDOW_SAMPLES) {
    return audio.slice(audio.length - TURN_WINDOW_SAMPLES);
  }
  const padded = new Float32Array(TURN_WINDOW_SAMPLES);
  padded.set(audio, TURN_WINDOW_SAMPLES - audio.length);
  return padded;
}

/**
 * Zero mean, unit variance, over every sample given — the leading zeros included.
 *
 * Including the padding looks wrong and is correct: `do_normalize` makes the extractor
 * return an attention mask, and the array is already at `max_length`, so the mask is all
 * ones and the statistics are taken over the lot. Normalising the speech alone would
 * scale a short utterance differently from a long one, which is the opposite of what the
 * step is for.
 *
 * Population variance, and the `1e-7` is the reference implementation's: without it,
 * eight seconds of digital silence divides by zero and every mel bin becomes NaN.
 */
export function zeroMeanUnitVariance(samples: Float32Array): Float32Array {
  let sum = 0;
  for (const sample of samples) sum += sample;
  const mean = sum / samples.length;

  let sumSquares = 0;
  for (const sample of samples) {
    const centred = sample - mean;
    sumSquares += centred * centred;
  }
  const scale = Math.sqrt(sumSquares / samples.length + 1e-7);

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = ((samples[i] as number) - mean) / scale;
  }
  return out;
}

/** Both steps, in the order the reference does them. What the extractor is handed. */
export function prepareTurnWindow(audio: Float32Array): Float32Array {
  return zeroMeanUnitVariance(windowForTurn(audio));
}

/**
 * Whisper's log-mel ends with `(max(x, x.max() - 8) + 4) / 4`, so the block spans exactly
 * two units unless the input is perfectly flat. A feature block that fails this is not a
 * Whisper log-mel, whatever its shape, and a probability computed from it means nothing.
 *
 * Cheap enough to run on every inference, which is the point: it checks the extractor on
 * the machine taking the measurement rather than in a test that agrees with itself.
 */
export const FEATURE_SPAN = 2;

export function featureSpanIsPlausible(features: Float32Array, tolerance = 1e-3): boolean {
  if (features.length === 0) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const value of features) {
    if (!Number.isFinite(value)) return false;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Math.abs(max - min - FEATURE_SPAN) <= tolerance;
}
