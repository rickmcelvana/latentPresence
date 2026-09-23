import { describe, expect, it } from 'vitest';
import { CharacterGestureSchema, type Mood, type SocialStance } from '@latentpresence/protocol';
import type { MoodParams } from '../life/params';
import { GESTURE_MOTIONS } from '../mappings/gestures';
import { REGION_BODY, affectToBody, modulateMood, type AffectInputs } from './body';
import { affectRegion } from './regions';

const NEUTRAL_MOOD: Mood = { pleasure: 0.2, arousal: 0.05, dominance: 0 };
const NEUTRAL_STANCE: SocialStance = { warmth: 0, formality: 0, engagement: 0 };
const NO_FEELING = { label: 'neutral' as const, intensity: 0 };
const IDENTITY_GAZE = { lookAwayScale: 1, holdScale: 1, awayMeanScale: 1, blinkScale: 1, breathScale: 1 };

function inputs(overrides: Partial<AffectInputs> = {}): AffectInputs {
  return { mood: NEUTRAL_MOOD, energy: 0.5, stance: NEUTRAL_STANCE, feeling: NO_FEELING, ...overrides };
}

describe('REGION_BODY table', () => {
  it('keeps every face weight at or under 0.35', () => {
    for (const body of Object.values(REGION_BODY)) {
      for (const weight of Object.values(body.face)) expect(weight).toBeLessThanOrEqual(0.35);
    }
  });

  it('gives every region a non-empty, known gesture bias with the performable ones first', () => {
    for (const body of Object.values(REGION_BODY)) {
      expect(body.gestureBias.length).toBeGreaterThan(0);
      for (const gesture of body.gestureBias) expect(CharacterGestureSchema.options).toContain(gesture);
      const performable = body.gestureBias.map((gesture) => GESTURE_MOTIONS[gesture] !== null);
      const firstUnperformable = performable.indexOf(false);
      if (firstUnperformable !== -1) expect(performable.slice(firstUnperformable)).not.toContain(true);
    }
  });
});

describe('affectToBody', () => {
  it('is an empty face at strength 0 with no feeling', () => {
    expect(affectRegion(NEUTRAL_MOOD)).toBe('neutral');
    const body = affectToBody(inputs());
    expect(body.strength).toBe(0);
    expect(body.expression).toEqual({});
  });

  it('is the identity gaze at strength 0, energy 0.5, engagement ≤ 0', () => {
    for (const body of [affectToBody(inputs()), affectToBody(inputs({ stance: { ...NEUTRAL_STANCE, engagement: -0.5 } }))]) {
      expect(body.gaze.lookAwayScale).toBeCloseTo(1, 10);
      expect(body.gaze.holdScale).toBeCloseTo(1, 10);
      expect(body.gaze.awayMeanScale).toBeCloseTo(1, 10);
      expect(body.gaze.blinkScale).toBeCloseTo(1, 10);
      expect(body.gaze.breathScale).toBeCloseTo(1, 10);
      expect(body.gaze.awayTargets).toBeUndefined();
    }
  });

  it('caps every output weight at 0.8', () => {
    const body = affectToBody(inputs({ mood: { pleasure: 1, arousal: 1, dominance: 1 }, feeling: { label: 'joy', intensity: 1 } }));
    for (const weight of Object.values(body.expression)) expect(weight).toBeLessThanOrEqual(0.8);
  });

  it("shows the feeling at its own intensity when the region contributes nothing", () => {
    const body = affectToBody(inputs({ feeling: { label: 'joy', intensity: 0.5 } }));
    // EMOTION_EXPRESSIONS.joy is { happy: 0.7 }; at intensity 0.5 that is 0.35.
    expect(body.expression).toEqual({ happy: 0.35 });
  });

  it('max-merges the feeling with the region face rather than replacing it', () => {
    const exuberant = { pleasure: 0.8, arousal: 0.8, dominance: 0.8 };
    const body = affectToBody(inputs({ mood: exuberant, feeling: { label: 'amusement', intensity: 0.1 } }));
    // exuberant's own happy (0.3 at full strength) beats amusement's 0.1 × 0.55.
    expect(body.expression.happy).toBeCloseTo(REGION_BODY.exuberant.face.happy ?? 0, 5);
  });

  it('resolves the idle clip against what is actually loaded, and reports what it wanted', () => {
    const exuberant = { pleasure: 0.8, arousal: 0.8, dominance: 0.8 };
    const fallback = affectToBody(inputs({ mood: exuberant }), ['idle']);
    expect(fallback.idleClipWanted).toBe('idle-bright');
    expect(fallback.idleClip).toBe('idle');
    const loaded = affectToBody(inputs({ mood: exuberant }), ['idle', 'idle-bright']);
    expect(loaded.idleClip).toBe('idle-bright');
  });

  it('moves lean-in first once engagement is over half, and lowers lookAwayScale', () => {
    const exuberant = { pleasure: 0.8, arousal: 0.8, dominance: 0.8 };
    const engaged = affectToBody(inputs({ mood: exuberant, stance: { ...NEUTRAL_STANCE, engagement: 0.8 } }));
    const unengaged = affectToBody(inputs({ mood: exuberant }));
    expect(engaged.gestureBias[0]).toBe('lean-in');
    expect(unengaged.gestureBias[0]).not.toBe('lean-in');
    expect(engaged.gaze.lookAwayScale).toBeLessThan(unengaged.gaze.lookAwayScale);
  });

  it('moves breath up and blink down with energy', () => {
    const low = affectToBody(inputs({ energy: 0 }));
    const high = affectToBody(inputs({ energy: 1 }));
    expect(high.gaze.breathScale).toBeGreaterThan(low.gaze.breathScale);
    expect(high.gaze.blinkScale).toBeLessThan(low.gaze.blinkScale);
  });
});

describe('modulateMood', () => {
  const base: MoodParams = {
    breathsPerMinute: 14,
    blinkMeanMs: 3000,
    lookAwayChance: 0.4,
    holdMeanMs: 2000,
    awayMeanMs: 1000,
    awayTargets: ['wander', 'away'],
  };

  it('clamps lookAwayChance to 0..0.95', () => {
    expect(modulateMood(base, { ...IDENTITY_GAZE, lookAwayScale: 10 }).lookAwayChance).toBe(0.95);
    expect(modulateMood(base, { ...IDENTITY_GAZE, lookAwayScale: 0 }).lookAwayChance).toBe(0);
  });

  it('clamps every …Ms duration to at least 300', () => {
    const modulated = modulateMood(base, { ...IDENTITY_GAZE, holdScale: 0.001, awayMeanScale: 0.001, blinkScale: 0.001 });
    expect(modulated.holdMeanMs).toBeGreaterThanOrEqual(300);
    expect(modulated.awayMeanMs).toBeGreaterThanOrEqual(300);
    expect(modulated.blinkMeanMs).toBeGreaterThanOrEqual(300);
  });

  it('clamps breathsPerMinute to 6..30', () => {
    expect(modulateMood(base, { ...IDENTITY_GAZE, breathScale: 10 }).breathsPerMinute).toBe(30);
    expect(modulateMood(base, { ...IDENTITY_GAZE, breathScale: 0 }).breathsPerMinute).toBe(6);
  });

  it('replaces awayTargets only when the modulation names one', () => {
    expect(modulateMood(base, IDENTITY_GAZE).awayTargets).toEqual(base.awayTargets);
    expect(modulateMood(base, { ...IDENTITY_GAZE, awayTargets: ['down'] }).awayTargets).toEqual(['down']);
  });
});
