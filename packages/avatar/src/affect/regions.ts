import type { Mood } from '@latentpresence/protocol';

/**
 * Where the mood sits in Mehrabian's PAD space (P3-T02): the eight octants by the sign of
 * pleasure, arousal and dominance, plus `neutral` for a mood close to the origin. This is
 * what the resting face, the gaze habit and the idle clip key off — the fast, tag-driven
 * feeling (`AffectInputs['feeling']` in `./body`) rides on top of it, not instead of it.
 */
export type AffectRegion =
  | 'neutral'
  | 'exuberant'
  | 'dependent'
  | 'relaxed'
  | 'docile'
  | 'hostile'
  | 'anxious'
  | 'disdainful'
  | 'bored';

/**
 * Half the width of the neutral cube on every axis. The character's default baseline
 * (`docs/affect.md`: pleasure 0.2, arousal 0.05, dominance 0) has to classify as neutral,
 * and 0.25 is the plainest number that clears it with room to spare.
 */
export const NEUTRAL_RADIUS = 0.25;

/**
 * The octant `mood` falls in, or `neutral` when every axis is within `NEUTRAL_RADIUS` of
 * the origin. A component of exactly 0 counts as `+`, so every point outside the neutral
 * cube lands in exactly one octant — there is no sign combination this leaves unmapped.
 */
export function affectRegion(mood: Mood): AffectRegion {
  const { pleasure, arousal, dominance } = mood;
  if (Math.abs(pleasure) < NEUTRAL_RADIUS && Math.abs(arousal) < NEUTRAL_RADIUS && Math.abs(dominance) < NEUTRAL_RADIUS) {
    return 'neutral';
  }
  const p = pleasure >= 0;
  const a = arousal >= 0;
  const d = dominance >= 0;
  if (p && a && d) return 'exuberant';
  if (p && a && !d) return 'dependent';
  if (p && !a && d) return 'relaxed';
  if (p && !a && !d) return 'docile';
  if (!p && a && d) return 'hostile';
  if (!p && a && !d) return 'anxious';
  if (!p && !a && d) return 'disdainful';
  return 'bored';
}

/**
 * How far into its octant `mood` sits, 0..1: 0 anywhere `affectRegion` calls `neutral`,
 * otherwise the PAD vector's length past `NEUTRAL_RADIUS`, scaled so a length of 1 reads
 * as 1 and clamped beyond that — a mood can sit in a corner, past length 1, when more than
 * one axis is pushed hard.
 */
export function regionStrength(mood: Mood): number {
  if (affectRegion(mood) === 'neutral') return 0;
  const { pleasure, arousal, dominance } = mood;
  const length = Math.sqrt(pleasure * pleasure + arousal * arousal + dominance * dominance);
  return Math.min(1, Math.max(0, (length - NEUTRAL_RADIUS) / (1 - NEUTRAL_RADIUS)));
}
