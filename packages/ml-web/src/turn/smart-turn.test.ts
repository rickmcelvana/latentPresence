import * as ort from 'onnxruntime-web';
import { describe, expect, it } from 'vitest';
import type { OrtSessionLike } from './silero';
import { SmartTurnModel } from './smart-turn';
import { FEATURE_SPAN } from './turn-audio';

/**
 * The model file is not here, but the real feature extractor is: it is pure JS, and it is
 * the half where a mistake is invisible. These tests hand it audio and inspect exactly
 * what would have reached the graph.
 */
class CapturingSession implements OrtSessionLike {
  features: ort.Tensor | null = null;
  output: Record<string, ort.Tensor | undefined> = {
    logits: new ort.Tensor('float32', Float32Array.from([0.83]), [1, 1]),
  };

  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor | undefined>> {
    this.features = feeds['input_features'] ?? null;
    return Promise.resolve(this.output);
  }
}

/** A second of something speech-shaped: a few harmonics with an envelope, at 16 kHz. */
function voiced(seconds: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * 16_000) }, (_, i) => {
    const t = i / 16_000;
    const envelope = Math.sin(Math.PI * ((t * 3) % 1));
    return 0.3 * envelope * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t));
  });
}

describe('SmartTurnModel', () => {
  it('hands the graph an 80x800 Whisper log-mel spanning exactly the clamp width', async () => {
    const session = new CapturingSession();
    const result = await new SmartTurnModel(session).judge(voiced(1.5));

    expect(result.probability).toBeCloseTo(0.83);
    expect(session.features?.dims).toEqual([1, 80, 800]);
    const data = session.features?.data as Float32Array;
    let min = Infinity;
    let max = -Infinity;
    for (const value of data) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    expect(max - min).toBeCloseTo(FEATURE_SPAN, 3);
  }, 20_000);

  it('puts a short utterance at the end of the window, where the model looks', async () => {
    const session = new CapturingSession();
    await new SmartTurnModel(session).judge(voiced(1));
    const data = session.features?.data as Float32Array;
    // The loudest bin per frame: padding sits on the clamp floor, voiced frames reach the
    // top. A mean over all 80 bins would drown two harmonics in empty bins.
    const frameMax = (frame: number): number => {
      let peak = -Infinity;
      for (let bin = 0; bin < 80; bin += 1) peak = Math.max(peak, data[bin * 800 + frame] ?? -Infinity);
      return peak;
    };
    const average = (from: number): number =>
      Array.from({ length: 100 }, (_, i) => frameMax(from + i)).reduce((a, b) => a + b) / 100;
    // First second of the window against the last, on a span of 2.
    expect(average(700) - average(0)).toBeGreaterThan(1);
  }, 20_000);

  it('refuses an output that is not a probability', async () => {
    const session = new CapturingSession();
    session.output = { logits: new ort.Tensor('float32', Float32Array.from([3.2]), [1, 1]) };
    await expect(new SmartTurnModel(session).judge(voiced(1))).rejects.toThrow(/expected a probability/u);
  }, 20_000);

  it('refuses a graph with no logits output', async () => {
    const session = new CapturingSession();
    session.output = {};
    await expect(new SmartTurnModel(session).judge(voiced(1))).rejects.toThrow(/logits/u);
  }, 20_000);

  it('refuses to score digital silence, whose features cannot span the clamp', async () => {
    // Eight seconds of zeros normalises to zeros, and a flat log-mel has a span of 0 —
    // there is nothing to judge, and a number here would be made up.
    const session = new CapturingSession();
    await expect(new SmartTurnModel(session).judge(new Float32Array(16_000))).rejects.toThrow(/Whisper log-mel/u);
    expect(session.features).toBeNull();
  }, 20_000);
});
