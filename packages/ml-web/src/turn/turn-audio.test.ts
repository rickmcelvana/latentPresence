import { describe, expect, it } from 'vitest';
import {
  FEATURE_SPAN,
  TURN_WINDOW_SAMPLES,
  featureSpanIsPlausible,
  prepareTurnWindow,
  windowForTurn,
  zeroMeanUnitVariance,
} from './turn-audio';

/**
 * The invariants that decide whether every probability in `docs/spikes/D-smart-turn.md`
 * means anything.
 *
 * Each of these guards a way of being wrong that the harness cannot show: the model
 * answers a malformed window with a confident number rather than an error, so a defect
 * here reads as a result.
 */

/** A ramp, so a test can say *which* samples survived rather than only how many. */
function ramp(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => i + 1);
}

describe('windowForTurn', () => {
  it('keeps the end of a long utterance, not the beginning', () => {
    // Someone talking for twelve seconds: the model endpoints on what they just said.
    // Taking the first eight would ask it about a sentence that finished long ago.
    const audio = ramp(TURN_WINDOW_SAMPLES + 5000);
    const window = windowForTurn(audio);

    expect(window.length).toBe(TURN_WINDOW_SAMPLES);
    expect(window.at(-1)).toBe(audio.at(-1));
    expect(window[0]).toBe(audio[5000]);
  });

  it('pads a short utterance at the front, leaving speech against the end', () => {
    // The whole point of the module. Padding at the back — which is what
    // transformers.js does on its own — puts silence where the model looks for the
    // end of the sentence, and every short turn reads as unfinished.
    const audio = ramp(1000);
    const window = windowForTurn(audio);

    expect(window.length).toBe(TURN_WINDOW_SAMPLES);
    expect(window.at(-1)).toBe(1000);
    expect(window[TURN_WINDOW_SAMPLES - 1000]).toBe(1);
    expect(window[TURN_WINDOW_SAMPLES - 1001]).toBe(0);
    expect(window[0]).toBe(0);
  });

  it('passes exactly eight seconds through untouched', () => {
    const audio = ramp(TURN_WINDOW_SAMPLES);
    const window = windowForTurn(audio);

    expect(window.length).toBe(TURN_WINDOW_SAMPLES);
    expect(window[0]).toBe(1);
    expect(window.at(-1)).toBe(TURN_WINDOW_SAMPLES);
  });
});

describe('zeroMeanUnitVariance', () => {
  it('gives mean 0 and population variance 1', () => {
    const samples = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i / 7) * 0.3 + 0.1);
    const normalised = zeroMeanUnitVariance(samples);

    const mean = normalised.reduce((sum, value) => sum + value, 0) / normalised.length;
    const variance =
      normalised.reduce((sum, value) => sum + (value - mean) ** 2, 0) / normalised.length;

    expect(mean).toBeCloseTo(0, 5);
    expect(variance).toBeCloseTo(1, 4);
  });

  it('takes its statistics over the padding as well as the speech', () => {
    // `do_normalize` forces an attention mask that is all ones once the array is at
    // max_length, so the zeros count. Normalising the speech alone would scale a short
    // utterance differently from a long one — the model would see a two-word answer
    // shouted and a long sentence murmured.
    const speech = Float32Array.from({ length: 1000 }, () => 1);
    const window = windowForTurn(speech);
    const normalised = zeroMeanUnitVariance(window);

    const speechOnly = zeroMeanUnitVariance(speech);
    // Constant speech normalised alone is ~0 everywhere; in context it is not.
    expect(Math.abs(speechOnly.at(-1) as number)).toBeLessThan(0.01);
    expect(Math.abs(normalised.at(-1) as number)).toBeGreaterThan(1);
  });

  it('survives silence without producing NaN', () => {
    // Eight seconds of digital zero has zero variance. Without the 1e-7 this divides by
    // zero and every mel bin downstream becomes NaN — which onnxruntime happily runs.
    const normalised = zeroMeanUnitVariance(new Float32Array(TURN_WINDOW_SAMPLES));

    expect([...normalised].every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe('prepareTurnWindow', () => {
  it('does both steps and hands over exactly the model window', () => {
    const prepared = prepareTurnWindow(ramp(2000));

    expect(prepared.length).toBe(TURN_WINDOW_SAMPLES);
    expect([...prepared].every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe('featureSpanIsPlausible', () => {
  it('accepts a block spanning exactly the clamp width', () => {
    const features = Float32Array.from({ length: 128 }, (_, i) => (i / 127) * FEATURE_SPAN);

    expect(featureSpanIsPlausible(features)).toBe(true);
  });

  it('rejects a block that is not a Whisper log-mel', () => {
    // The shape of a wrong extractor config: right dimensions, wrong scale.
    const tooWide = Float32Array.from({ length: 128 }, (_, i) => i);
    const tooNarrow = Float32Array.from({ length: 128 }, (_, i) => i / 1000);

    expect(featureSpanIsPlausible(tooWide)).toBe(false);
    expect(featureSpanIsPlausible(tooNarrow)).toBe(false);
  });

  it('rejects NaN rather than measuring its span', () => {
    const withNaN = Float32Array.from([0, Number.NaN, FEATURE_SPAN]);

    expect(featureSpanIsPlausible(withNaN)).toBe(false);
  });
});
