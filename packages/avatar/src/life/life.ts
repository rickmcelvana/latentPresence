import type { ConversationState, GazeTarget } from '@latentpresence/protocol';
import { modulateMood, type GazeModulation } from '../affect/body';
import { type GazeOffset, type Vec3, gazeDirection } from '../gaze';
import { BlinkScheduler } from './blink';
import { Breathing } from './breathing';
import { GazePolicy } from './gaze-policy';
import { DEFAULT_LIFE_PARAMS, type LifeParams } from './params';
import { createRandom } from './random';
import { WeightShift } from './weight-shift';

/**
 * The humanoid bones the life layer moves — all VRM 1.0 names, so a renderer can hand
 * them to three-vrm unchanged. `upperChest` is optional in VRM; a rig without it just
 * breathes a little less.
 */
export const LIFE_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
] as const;
export type LifeBone = (typeof LIFE_BONES)[number];

/** The most time one `update` will advance; see `LifeLayer.update`. */
export const MAX_STEP_MS = 100;

/** Euler XYZ, radians, in the bone's normalised frame (VRM 1.0: +Y up, facing +Z). */
export type BoneRotations = Partial<Record<LifeBone, Vec3>>;

export interface LifePose {
  /** Added on top of whatever a clip is doing. */
  readonly additive: BoneRotations;
  /** The arms-down rest pose, for when no clip is playing (P2-T03 brings its own). */
  readonly rest: BoneRotations;
  /** Metres, added to the hips. */
  readonly hipsOffset: Vec3;
  /** 0 open, 1 shut. */
  readonly blink: number;
  readonly gaze: { readonly target: GazeTarget; readonly offset: GazeOffset };
}

/**
 * Breathing, blinking, gaze and weight shifts, composed into one pose a frame.
 *
 * Pure and three-free, like the rest of the package's root: it knows bone names and
 * radians and nothing about a scene, so all of it is tested by stepping time in node, and
 * the renderer only has to apply the result (`VrmAvatarRenderer.setLifePose`).
 *
 * **The conversation state is the only input it needs** (`setState`) — rates and gaze
 * habits follow it — plus an optional base gaze target for when something wants the eyes
 * elsewhere. Seeded, so two runs with one seed are the same minute.
 *
 * **`setModulation`** (P3-T02) layers a `GazeModulation` from `affectToBody` on top of the
 * state's own `MoodParams` (`modulateMood`), applied fresh in `update` every frame. `null`
 * — the default — changes nothing, so a run that never calls it is identical to before
 * this existed.
 *
 * Sign conventions, in the normalised rig: turning towards the character's left is +Y,
 * looking up is -X, leaning back is -X, the left arm lowers with -Z and the right with +Z.
 * The Browser pane is where they were checked, not the head.
 */
export class LifeLayer {
  private readonly params: LifeParams;
  private state: ConversationState = 'idle';
  private readonly breathing: Breathing;
  private readonly blink: BlinkScheduler;
  private readonly gaze: GazePolicy;
  private readonly weight: WeightShift;
  /** Head turn so far, [yaw, pitch], easing towards where the eyes are. */
  private head: [number, number] = [0, 0];
  /** A `GazeModulation` applied on top of the state's own mood; `null` changes nothing. */
  private modulation: GazeModulation | null = null;

  constructor(params: LifeParams = DEFAULT_LIFE_PARAMS, seed = 1) {
    this.params = params;
    const random = createRandom(seed);
    const mood = params.moods[this.state];
    this.breathing = new Breathing(params.breathing.inhaleShare, random());
    this.blink = new BlinkScheduler(params.blink, random, mood.blinkMeanMs);
    this.gaze = new GazePolicy(params.gaze, random, mood);
    this.weight = new WeightShift(params.weightShift, random);
  }

  setState(state: ConversationState): void {
    this.state = state;
  }

  /** Where the eyes rest when not looking away; the user unless something says otherwise. */
  setGazeBase(target: GazeTarget): void {
    if (this.gaze.setBase(target)) this.blink.withSaccade();
  }

  /** `affectToBody`'s gaze multipliers on top of the state's own mood; `null` (the
   * default) drives the state's mood unchanged. */
  setModulation(gaze: GazeModulation | null): void {
    this.modulation = gaze;
  }

  /**
   * Advances everything by `deltaMs`, capped at `MAX_STEP_MS`: a tab that comes back from
   * the background hands over seconds in one frame, and the character should carry on
   * from where it was rather than replay every blink it missed in one go.
   */
  update(deltaMs: number): LifePose {
    deltaMs = Math.min(Math.max(0, deltaMs), MAX_STEP_MS);
    const baseMood = this.params.moods[this.state];
    const mood = this.modulation === null ? baseMood : modulateMood(baseMood, this.modulation);
    const { breathing, gaze: gazeParams, rest } = this.params;

    const breath = this.breathing.update(deltaMs, mood.breathsPerMinute);
    const gaze = this.gaze.update(deltaMs, mood);
    if (gaze.shifted) this.blink.withSaccade();
    const blink = this.blink.update(deltaMs, mood.blinkMeanMs);
    const stance = this.weight.update(deltaMs);

    // The head follows part of the eyes' turn, late, the way a head does.
    const [side, up, ahead] = gazeDirection(gaze.target, gaze.offset);
    const goal: [number, number] = [
      Math.atan2(side, ahead) * gazeParams.headFollow,
      Math.atan2(up, ahead) * gazeParams.headFollow,
    ];
    const ease = 1 - Math.exp(-deltaMs / Math.max(1, gazeParams.headLagMs));
    this.head = [this.head[0] + (goal[0] - this.head[0]) * ease, this.head[1] + (goal[1] - this.head[1]) * ease];
    const [yaw, pitch] = this.head;

    const chest = -breath * breathing.chestPitch * 0.5;
    const shoulder = breath * breathing.shoulderLift;

    return {
      additive: {
        hips: [0, 0, stance.hipRoll],
        spine: [0, 0, stance.spineRoll],
        chest: [chest, 0, 0],
        upperChest: [chest, 0, 0],
        // Neck takes 40% of the turn and the head the rest.
        neck: [-pitch * 0.4, yaw * 0.4, 0],
        head: [-pitch * 0.6, yaw * 0.6, 0],
        leftShoulder: [0, 0, shoulder],
        rightShoulder: [0, 0, -shoulder],
      },
      rest: {
        leftUpperArm: [0, 0, -rest.upperArmDrop],
        rightUpperArm: [0, 0, rest.upperArmDrop],
        leftLowerArm: [0, -rest.elbowBend, 0],
        rightLowerArm: [0, rest.elbowBend, 0],
      },
      hipsOffset: [stance.hipShift, 0, 0],
      blink,
      gaze: { target: gaze.target, offset: gaze.offset },
    };
  }
}
