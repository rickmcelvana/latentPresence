import { describe, expect, it } from 'vitest';
import { UserEmotionSchema } from '@latentpresence/protocol';
import {
  BASE_LABELS,
  DISTILL_POSES,
  DISTILL_WINDOW_SAMPLES,
  POSE_LABEL,
  SER_MODELS,
  classifyFrames,
  distillWindows,
  parseHead,
  poseProbabilities,
  poseWeights,
  serModels,
} from './messages';

describe('the SER catalog (P3-T05)', () => {
  it('pins every file to a revision and states the licence on each consent line', () => {
    for (const key of ['base', 'distill'] as const) {
      expect(SER_MODELS[key].revision).toMatch(/^[0-9a-f]{40}$/u);
      for (const descriptor of serModels(key)) {
        expect(descriptor.licence).toContain('FunASR');
        expect(descriptor.sizeBytes).toBeGreaterThan(0);
      }
    }
    // The base model is two downloads, the graph and its head; both are asked about.
    expect(serModels('base').map((descriptor) => descriptor.sizeBytes)).toEqual([373_159_295, 128_472]);
  });

  it("uses exactly the protocol's user emotions, in the head's order", () => {
    expect([...BASE_LABELS].toSorted()).toEqual([...UserEmotionSchema.options].toSorted());
    for (const label of Object.values(POSE_LABEL)) expect(BASE_LABELS).toContain(label);
  });
});

describe('the base model arithmetic', () => {
  const head = {
    labels: BASE_LABELS,
    weight: Array.from({ length: 9 }, (_, k) => Array.from({ length: 768 }, (__, d) => (k === 6 && d === 0 ? 10 : 0))),
    bias: Array.from({ length: 9 }, () => 0),
  };

  it('refuses a head that is not the one the catalog promised', () => {
    expect(() => parseHead({ ...head, labels: ['a'] })).toThrow(/labels/u);
    expect(() => parseHead({ ...head, bias: [0] })).toThrow(/9×768/u);
  });

  it('mean-pools the frames before the head', () => {
    // Feature 0 is 1 in one frame and 0 in the other: pooled 0.5, so "sad" gets logit 5.
    const features = new Float32Array(2 * 768);
    features[0] = 1;
    const p = classifyFrames(features, 2, 768, parseHead(head));
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(p[6]).toBeCloseTo(Math.exp(5) / (Math.exp(5) + 8), 10);
  });
});

describe('the distill arithmetic', () => {
  it('takes the last windows of a segment, padding a short one in front', () => {
    const short = distillWindows(new Float32Array(16_000).fill(1));
    expect(short.windows).toBe(1);
    expect(short.data[0]).toBe(0);
    expect(short.data[DISTILL_WINDOW_SAMPLES - 1]).toBe(1);
    const long = new Float32Array(10 * 16_000).map((_, i) => i);
    const windows = distillWindows(long);
    expect(windows.windows).toBe(2);
    expect(windows.data.at(-1)).toBe(long.at(-1));
  });

  it('averages pose weights over windows and folds them into user emotions', () => {
    const n = DISTILL_POSES.length;
    const cosines = new Float32Array(2 * n);
    cosines[DISTILL_POSES.indexOf('sad')] = 1;
    cosines[n + DISTILL_POSES.indexOf('weary')] = 1;
    const weights = poseWeights(cosines, 2);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // sad and weary both fold into `sad`: nearly all the mass.
    expect(poseProbabilities(weights)[BASE_LABELS.indexOf('sad')]).toBeGreaterThan(0.99);
  });
});
