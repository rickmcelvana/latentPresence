import { describe, expect, it } from 'vitest';
import type { Mood } from '@latentpresence/protocol';
import { NEUTRAL_RADIUS, affectRegion, regionStrength, type AffectRegion } from './regions';

function mood(pleasure: number, arousal: number, dominance: number): Mood {
  return { pleasure, arousal, dominance };
}

/** One point clearly inside each octant, |component| well past the neutral radius. */
const OCTANTS: readonly (readonly [AffectRegion, Mood])[] = [
  ['exuberant', mood(0.6, 0.6, 0.6)],
  ['dependent', mood(0.6, 0.6, -0.6)],
  ['relaxed', mood(0.6, -0.6, 0.6)],
  ['docile', mood(0.6, -0.6, -0.6)],
  ['hostile', mood(-0.6, 0.6, 0.6)],
  ['anxious', mood(-0.6, 0.6, -0.6)],
  ['disdainful', mood(-0.6, -0.6, 0.6)],
  ['bored', mood(-0.6, -0.6, -0.6)],
];

describe('affectRegion', () => {
  it('names every octant from a point clearly inside it', () => {
    for (const [region, point] of OCTANTS) expect(affectRegion(point)).toBe(region);
  });

  // docs/affect.md: pleasure 0.2, arousal 0.05, dominance 0 — must read as neutral.
  it('classifies the character’s default baseline as neutral', () => {
    expect(affectRegion(mood(0.2, 0.05, 0))).toBe('neutral');
  });

  it('treats a zero component as +', () => {
    expect(affectRegion(mood(0, 0.6, 0.6))).toBe('exuberant');
    expect(affectRegion(mood(0.6, 0, 0.6))).toBe('exuberant');
    expect(affectRegion(mood(0.6, 0.6, 0))).toBe('exuberant');
    expect(affectRegion(mood(0, 0, 0))).toBe('neutral');
  });

  it('is neutral strictly inside the radius on every axis, and not just past it', () => {
    expect(affectRegion(mood(NEUTRAL_RADIUS - 0.01, 0, 0))).toBe('neutral');
    // Crossing the radius on pleasure alone, with the other two axes at 0 (which count
    // as +), lands in exuberant.
    expect(affectRegion(mood(NEUTRAL_RADIUS + 0.01, 0, 0))).toBe('exuberant');
  });
});

describe('regionStrength', () => {
  it('is 0 anywhere inside the neutral radius', () => {
    expect(regionStrength(mood(0, 0, 0))).toBe(0);
    expect(regionStrength(mood(0.2, 0.05, 0))).toBe(0);
    expect(regionStrength(mood(NEUTRAL_RADIUS - 0.001, 0, 0))).toBe(0);
  });

  it('reaches 1 at a PAD vector length of 1', () => {
    expect(regionStrength(mood(1, 0, 0))).toBeCloseTo(1, 10);
    expect(regionStrength(mood(0, -1, 0))).toBeCloseTo(1, 10);
    expect(regionStrength(mood(0, 0, 1))).toBeCloseTo(1, 10);
  });

  it('is clamped at 1 past that length, in a corner', () => {
    expect(regionStrength(mood(1, 1, 1))).toBe(1);
  });

  it('is monotone along a ray out from the origin', () => {
    const direction = { pleasure: 0.5, arousal: -0.3, dominance: 0.8 };
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.01) {
      const strength = regionStrength(mood(direction.pleasure * t, direction.arousal * t, direction.dominance * t));
      expect(strength).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = strength;
    }
  });
});
