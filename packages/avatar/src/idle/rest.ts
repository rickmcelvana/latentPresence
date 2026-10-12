import type { BoneRotations } from '../life/life';

/**
 * Her rest (P6-T04, ADR-53): head a little down, eyes closed, held while she sleeps on what was
 * said; the breathing under it is the life layer's own. She settles into it slowly and comes out
 * of it quickly — someone is there.
 */

/** At full rest; scaled by the level. Forward is +X, as the life layer's. */
export const REST_POSE: Readonly<Record<'head' | 'neck' | 'chest', readonly [number, number, number]>> = {
  head: [0.26, 0, 0.04],
  neck: [0.1, 0, 0],
  chest: [0.04, 0, 0],
};

export const REST_IN_MS = 2500;
export const REST_OUT_MS = 350;

/** The level one frame on: towards 1 over `REST_IN_MS` while resting, towards 0 over `REST_OUT_MS` after. */
export function restLevel(current: number, resting: boolean, deltaMs: number): number {
  const next = resting ? current + deltaMs / REST_IN_MS : current - deltaMs / REST_OUT_MS;
  return Math.min(1, Math.max(0, next));
}

/** The rest's rotations and closed eyes at `level`, eased so it settles rather than drops. */
export function restFrame(level: number): { readonly additive: BoneRotations; readonly eyesClosed: number } {
  const eased = level * level * (3 - 2 * level);
  const additive: BoneRotations = {};
  for (const [bone, [x, y, z]] of Object.entries(REST_POSE) as [keyof typeof REST_POSE, readonly [number, number, number]][]) additive[bone] = [x * eased, y * eased, z * eased];
  return { additive, eyesClosed: Math.min(1, eased * 1.2) };
}
