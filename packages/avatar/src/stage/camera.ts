import type { Vec3 } from '../gaze';

/**
 * Camera presets, the framing they compute and an eased rig to move between them.
 *
 * Pure and three-free, in `gaze.ts`'s style: tuples in, tuples out, tested in node. The
 * character stands at the origin facing +Z (VRM 1.0), so every preset sits the camera on
 * +Z, looking back at her.
 */

/** `face` replaces the renderer's old `setCameraDistance` stand-in (P2-T04). */
export type CameraPreset = 'face' | 'bust' | 'medium' | 'full';

/**
 * The loaded model's own proportions, in world space: bone heights plus where the
 * character stands. A bone the rig lacks is `null`, and framing falls back rather than
 * reaching for a bone that is not there.
 */
export interface Body {
  readonly x: number;
  readonly z: number;
  /**
   * The head *bone* — which sits at the base of the skull, ~20 cm below the crown on the
   * placeholder. Not the top of the head: framing to it cropped the hair (P2-T05 review).
   */
  readonly head: number;
  /** The model's highest point — hair included — from its bounding box. */
  readonly top: number | null;
  /** Eye height, from the `leftEye`/`rightEye` bones (optional in VRM). */
  readonly eyes: number | null;
  readonly upperChest: number | null;
  readonly chest: number | null;
  readonly hips: number | null;
  readonly leftFoot: number | null;
  readonly rightFoot: number | null;
}

export interface Framing {
  readonly position: Vec3;
  readonly target: Vec3;
}

/** Fixed vertical FOV, as the renderer used before this task. */
export const DEFAULT_FOV_DEGREES = 30;

/** The share of the half-FOV the framed span may use; the rest is breathing room. */
const FILL = 0.9;

/** Space above the crown. */
const HEADROOM = 0.04;

/** Crown above the head bone, for a model with no bounding box to read (tests, odd rigs). */
const CROWN_FALLBACK = 0.25;

/** Eyes above the head bone, when the rig has no eye bones. */
const EYES_FALLBACK = 0.07;

/** `face`'s bottom: a little below the chin. */
const CHIN_OFFSET = 0.12;


/** Fallbacks for a rig missing the bone a preset would rather read. */
const BUST_FALLBACK_SPAN = 0.55;
const MEDIUM_FALLBACK_SPAN = 0.9;

function footHeight(body: Body): number | null {
  const feet = [body.leftFoot, body.rightFoot].filter((value): value is number => value !== null);
  if (feet.length === 0) return null;
  return feet.reduce((total, value) => total + value, 0) / feet.length;
}

function bottomOf(preset: CameraPreset, body: Body): number {
  switch (preset) {
    case 'face':
      return body.head - CHIN_OFFSET;
    case 'bust':
      return body.upperChest ?? body.chest ?? body.head - BUST_FALLBACK_SPAN;
    case 'medium':
      return body.hips ?? body.head - MEDIUM_FALLBACK_SPAN;
    case 'full':
      return footHeight(body) ?? 0;
  }
}

/** The top of the frame for every preset: the crown, plus a little headroom. */
export function frameTop(body: Body): number {
  return (body.top ?? body.head + CROWN_FALLBACK) + HEADROOM;
}

/** Whether a point `dy` above the camera and `dz` in front of it is inside the view. */
function inside(pitch: number, dy: number, dz: number, limit: number): boolean {
  return Math.abs(Math.atan2(dy, dz) - pitch) <= limit;
}

/**
 * Where the camera sits and looks for a preset, given the loaded model's own proportions.
 *
 * The target is centred on the span the preset frames. `face` and `bust` put the camera at
 * the eyes, as a call does, so it looks slightly down at the span's centre; `medium` and
 * `full` keep it level at the centre, since from eye height a long span tips the view down
 * and the head leaves the frame. **The distance is solved with the tilt in it**: the
 * nearest distance at which both the top and the bottom of the span sit within `FILL` of
 * the half-FOV, measured from the camera's actual view direction.
 */
export function framing(preset: CameraPreset, body: Body, fovDegrees = DEFAULT_FOV_DEGREES): Framing {
  const top = frameTop(body);
  const bottom = bottomOf(preset, body);
  const centre = (top + bottom) / 2;
  const eyes = body.eyes ?? body.head + EYES_FALLBACK;
  const cameraY = preset === 'face' || preset === 'bust' ? eyes : centre;
  const limit = ((fovDegrees * Math.PI) / 360) * FILL;

  // Start where a level camera would need to be and step back until both edges fit.
  let distance = Math.max(0.2, (top - bottom) / 2 / Math.tan(limit));
  for (let i = 0; i < 400; i += 1) {
    const pitch = Math.atan2(centre - cameraY, distance);
    if (inside(pitch, top - cameraY, distance, limit) && inside(pitch, bottom - cameraY, distance, limit)) break;
    distance += 0.01;
  }

  return {
    position: [body.x, cameraY, body.z + distance],
    target: [body.x, centre, body.z],
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** t² (3 − 2t): zero slope at both ends, so an eased move starts and lands gently. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** The renderer's own default, if nothing else asks for a transition length. */
export const DEFAULT_TRANSITION_MS = 700;

/**
 * Eases the camera from wherever it currently is to a goal framing, over `transitionMs`.
 *
 * A new goal set mid-transition starts from the current (already-eased) pose, never from
 * the previous goal — so switching presets twice quickly never jumps. `transitionMs` of
 * `0` snaps, for the very first frame after a character loads.
 */
export class CameraRig {
  private start: Framing;
  private goal: Framing;
  private current: Framing;
  private elapsedMs = 0;
  private durationMs = 0;

  constructor(initial: Framing) {
    this.start = initial;
    this.goal = initial;
    this.current = initial;
  }

  setGoal(goal: Framing, transitionMs = DEFAULT_TRANSITION_MS): void {
    this.start = this.current;
    this.goal = goal;
    this.elapsedMs = 0;
    this.durationMs = Math.max(0, transitionMs);
  }

  /** Feed it the frame's delta; returns this frame's camera pose. */
  update(deltaMs: number): Framing {
    if (this.durationMs <= 0) {
      this.current = this.goal;
      return this.current;
    }
    this.elapsedMs = Math.min(this.durationMs, this.elapsedMs + deltaMs);
    const t = smoothstep(this.elapsedMs / this.durationMs);
    this.current = {
      position: lerpVec3(this.start.position, this.goal.position, t),
      target: lerpVec3(this.start.target, this.goal.target, t),
    };
    return this.current;
  }
}
