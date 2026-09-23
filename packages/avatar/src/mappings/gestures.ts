import type { CharacterGesture } from '@latentpresence/protocol';
import type { Vec3 } from '../gaze';
import type { BoneRotations, LifeBone } from '../life';

/**
 * `[gesture:x]` → the body (P2-T07). The free clip pack has no gesture clips (R-12), so
 * the head and shoulder gestures are procedural: a short additive motion on top of the
 * base clip and the life layer, like the life layer's own head. `wave` and `open-hands`
 * need arms and hands a formula cannot fake, so they are `null` until a clip exists — the
 * bridge reports them as unperformed rather than doing something else.
 *
 * Sign conventions are the life layer's, in the normalised rig: looking up is −X (so a
 * nod down is +X), turning to her left is +Y, and a head tilt is Z. The shoulders raise
 * with +Z on the left and −Z on the right, the mirror of the arms lowering.
 */
export interface GestureMotion {
  readonly durationMs: number;
  /** The additive rotation `t` ms into the gesture. Zero at both ends, so it never pops. */
  pose(t: number): BoneRotations;
}

function smooth(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** 0 → 1 → 0 over attack, hold and release, smoothstepped at both ends. */
function envelope(t: number, attack: number, hold: number, release: number): number {
  if (t <= 0) return 0;
  if (t < attack) return smooth(t / attack);
  if (t < attack + hold) return 1;
  return 1 - smooth((t - attack - hold) / release);
}

function scaled(rotation: Vec3, by: number): Vec3 {
  return [rotation[0] * by, rotation[1] * by, rotation[2] * by];
}

/** A held posture: every bone in `pose` eased in, held and eased out. */
function held(pose: Partial<Record<LifeBone, Vec3>>, attack: number, hold: number, release: number): GestureMotion {
  return {
    durationMs: attack + hold + release,
    pose: (t) => {
      const amount = envelope(t, attack, hold, release);
      return Object.fromEntries(Object.entries(pose).map(([bone, rotation]) => [bone, scaled(rotation, amount)]));
    },
  };
}

/** Down and back, twice: `1 − cos` per cycle so every cycle starts and ends at rest. */
const NOD: GestureMotion = {
  durationMs: 880,
  pose: (t) => {
    if (t <= 0 || t >= 880) return {};
    const dip = ((1 - Math.cos((2 * Math.PI * t) / 440)) / 2) * (t < 440 ? 0.16 : 0.1);
    return { head: [dip, 0, 0], neck: [dip * 0.4, 0, 0] };
  },
};

/** Side to side, three swings, fading so the last one settles at centre. */
const SHAKE: GestureMotion = {
  durationMs: 1080,
  pose: (t) => {
    if (t <= 0 || t >= 1080) return {};
    const turn = 0.16 * Math.sin((2 * Math.PI * t) / 360) * envelope(t, 120, 600, 360);
    return { head: [0, turn, 0], neck: [0, turn * 0.35, 0] };
  },
};

export const GESTURE_MOTIONS: Readonly<Record<CharacterGesture, GestureMotion | null>> = {
  nod: NOD,
  'shake-head': SHAKE,
  'tilt-head': held({ head: [0, 0, 0.16], neck: [0, 0, 0.05] }, 250, 1200, 450),
  'lean-in': held({ spine: [0.07, 0, 0], chest: [0.05, 0, 0], head: [-0.06, 0, 0] }, 400, 1600, 500),
  shrug: held({ leftShoulder: [0, 0, 0.16], rightShoulder: [0, 0, -0.16], head: [0, 0, 0.07] }, 220, 450, 380),
  think: held({ head: [-0.1, 0.08, 0.09], neck: [-0.03, 0.03, 0] }, 400, 1800, 500),
  wave: null,
  'open-hands': null,
};
