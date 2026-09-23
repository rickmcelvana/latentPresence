import type { GazeTarget } from '@latentpresence/protocol';

/**
 * Where in the world each `GazeTarget` is, so a renderer can point a look-at at it.
 *
 * Pure and three-free: tuples in, a tuple out. The directions are built from the line
 * between the character's head and the camera — the user *is* the camera in a video
 * call — so "away" stays away and "down" stays down whichever camera preset P2-T05
 * picks, instead of being hard-coded to one framing.
 *
 * P2-T01 places the targets; making them move — drift, saccades, the return to the user —
 * is the gaze policy's job (P2-T02), which is why `wander` is a fixed point just off the
 * user rather than something that wanders.
 */

export type Vec3 = readonly [number, number, number];

/**
 * Each target as sideways, up and forward components, in metres at the scale of a
 * seated person, relative to the head and measured along the head-to-camera line.
 * Sideways is positive towards the character's left.
 */
const DIRECTIONS: Record<Exclude<GazeTarget, 'user'>, Vec3> = {
  // Well off the camera and a little up: thinking, recalling, not looking at you.
  away: [0.7, 0.15, 0.6],
  // Just off the user's face — close enough to read as attention, far enough to move.
  wander: [0.18, 0.1, 1],
  // Low and to the other side, where a screen on the desk would be.
  screen: [-0.4, -0.35, 0.6],
  down: [0, -0.7, 0.5],
};

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalise(v: Vec3): Vec3 | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length < 1e-6 ? null : [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * The world position to look at.
 *
 * `user` is the camera itself. Everything else is placed on a horizontal basis facing
 * the camera, so a camera above or below the eyes tilts nothing but the `user` gaze.
 * A camera directly above the head has no horizontal direction; the character is then
 * assumed to face +Z, which is VRM 1.0's forward.
 */
export function gazePoint(target: GazeTarget, head: Vec3, camera: Vec3): Vec3 {
  if (target === 'user') return camera;

  const toCamera = subtract(camera, head);
  const forward = normalise([toCamera[0], 0, toCamera[2]]) ?? [0, 0, 1];
  // Up × forward: the character's left when it faces the camera.
  const left: Vec3 = [forward[2], 0, -forward[0]];
  const [side, up, ahead] = DIRECTIONS[target];

  return [
    head[0] + left[0] * side + forward[0] * ahead,
    head[1] + up,
    head[2] + left[2] * side + forward[2] * ahead,
  ];
}
