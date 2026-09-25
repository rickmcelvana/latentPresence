import { describe, expect, it } from 'vitest';
import { AffectReadingSchema } from '@latentpresence/protocol';
import { DEFAULT_FACE_PARAMS, FACE_EMOTIONS, FaceAffectReader, faceFeatures, faceScores, type FaceFeatures } from './user-face';

/** A resting face that is not all zeros: brows a little low, mouth corners a little down. */
const REST: Readonly<Record<string, number>> = {
  browDownLeft: 0.15,
  browDownRight: 0.12,
  mouthFrownLeft: 0.05,
  mouthFrownRight: 0.07,
  mouthSmileLeft: 0.02,
  mouthSmileRight: 0.03,
  browInnerUp: 0.04,
  jawOpen: 0.02,
};

const FACES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  happy: { ...REST, mouthSmileLeft: 0.75, mouthSmileRight: 0.7, cheekSquintLeft: 0.4, cheekSquintRight: 0.4 },
  sad: { ...REST, mouthFrownLeft: 0.4, mouthFrownRight: 0.42, browInnerUp: 0.45 },
  angry: { ...REST, browDownLeft: 0.6, browDownRight: 0.58, mouthPressLeft: 0.3, mouthPressRight: 0.3 },
  surprised: { ...REST, browInnerUp: 0.6, browOuterUpLeft: 0.55, browOuterUpRight: 0.55, eyeWideLeft: 0.5, eyeWideRight: 0.5, jawOpen: 0.5 },
  disgusted: { ...REST, noseSneerLeft: 0.4, noseSneerRight: 0.35, mouthUpperUpLeft: 0.3, mouthUpperUpRight: 0.3 },
  fearful: { ...REST, browInnerUp: 0.5, eyeWideLeft: 0.5, eyeWideRight: 0.5, mouthStretchLeft: 0.35, mouthStretchRight: 0.35 },
};

/** Feed `shapes` at 10 Hz from `from` for `ms`, returning the last reading. */
function hold(reader: FaceAffectReader, shapes: Readonly<Record<string, number>> | null, from: number, ms: number) {
  let reading = null;
  for (let t = from; t < from + ms; t += 100) reading = reader.push(shapes, t);
  return reading;
}

function zero(): FaceFeatures {
  return faceFeatures({});
}

describe('faceFeatures', () => {
  it('averages left and right and treats a missing shape as 0', () => {
    const features = faceFeatures({ mouthSmileLeft: 0.6, mouthSmileRight: 0.2, jawOpen: 0.3 });
    expect(features.smile).toBeCloseTo(0.4);
    expect(features.jawOpen).toBeCloseTo(0.3);
    expect(features.frown).toBe(0);
  });
});

describe('faceScores — the action-unit patterns', () => {
  it('a still face scores nothing', () => {
    for (const emotion of FACE_EMOTIONS) expect(faceScores(zero())[emotion]).toBe(0);
  });

  it('an open jaw with the brows still is speech, not surprise', () => {
    expect(faceScores({ ...zero(), jawOpen: 0.7 }).surprised).toBe(0);
  });

  it('a smile holds back anger and sadness', () => {
    const frowning = faceScores({ ...zero(), browDown: 0.4 }).angry;
    const smilingToo = faceScores({ ...zero(), browDown: 0.4, smile: 0.5 }).angry;
    expect(smilingToo).toBeLessThan(frowning * 0.5);
  });

  it('cheeks raised without a smile are a squint, not happiness', () => {
    expect(faceScores({ ...zero(), cheekRaise: 0.6 }).happy).toBe(0);
  });
});

describe('FaceAffectReader', () => {
  it('reads each expression against the resting face it settled on', () => {
    for (const [label, shapes] of Object.entries(FACES)) {
      const reader = new FaceAffectReader();
      const resting = hold(reader, REST, 0, 4000);
      expect(resting?.label, `${label}: at rest`).toBe('neutral');
      const reading = hold(reader, shapes, 4000, 1500);
      expect(reading?.label, label).toBe(label);
      expect(AffectReadingSchema.safeParse(reading).success).toBe(true);
    }
  });

  it('puts happiness pleasant and sadness unpleasant and low', () => {
    const happy = new FaceAffectReader();
    hold(happy, REST, 0, 4000);
    const smiling = hold(happy, FACES['happy'] ?? null, 4000, 1500);
    expect(smiling?.valence).toBeGreaterThan(0.3);
    const sad = new FaceAffectReader();
    hold(sad, REST, 0, 4000);
    const down = hold(sad, FACES['sad'] ?? null, 4000, 1500);
    expect(down?.valence).toBeLessThan(-0.3);
    expect(down?.arousal).toBeLessThan(0);
  });

  it("does not call someone's resting face a feeling: low brows at rest are not anger", () => {
    const reader = new FaceAffectReader();
    const glum = { ...REST, browDownLeft: 0.45, browDownRight: 0.45 };
    const reading = hold(reader, glum, 0, 5000);
    expect(reading?.label).toBe('neutral');
  });

  it('a smile held for a minute is still a smile', () => {
    const reader = new FaceAffectReader();
    hold(reader, REST, 0, 4000);
    const reading = hold(reader, FACES['happy'] ?? null, 4000, 60_000);
    expect(reading?.label).toBe('happy');
  });

  it('one frame is not a mood: a single frame of a frown moves nothing', () => {
    const reader = new FaceAffectReader();
    hold(reader, REST, 0, 4000);
    reader.push(FACES['angry'] ?? null, 4000);
    const after = hold(reader, REST, 4100, 300);
    expect(after?.label).toBe('neutral');
  });

  it('is trusted little until it has settled, and never beyond maxConfidence', () => {
    const reader = new FaceAffectReader();
    const early = hold(reader, FACES['happy'] ?? null, 0, 500);
    expect(early?.confidence ?? 1).toBeLessThan(0.2);
    hold(reader, REST, 500, 4000);
    const late = hold(reader, FACES['happy'] ?? null, 4500, 3000);
    expect(late?.confidence).toBeGreaterThan(0.4);
    expect(late?.confidence).toBeLessThanOrEqual(DEFAULT_FACE_PARAMS.maxConfidence);
  });

  it('has no reading before a face and none once the face has been gone a second', () => {
    const reader = new FaceAffectReader();
    expect(reader.push(null, 0)).toBeNull();
    hold(reader, REST, 100, 4000);
    expect(reader.push(null, 4200)).not.toBeNull();
    expect(hold(reader, null, 4200, 1500)).toBeNull();
  });

  it('settles again when a face comes back', () => {
    const reader = new FaceAffectReader();
    hold(reader, REST, 0, 4000);
    hold(reader, null, 4000, 3000);
    const back = reader.push(REST, 7000);
    expect(back?.confidence).toBe(0);
  });
});
