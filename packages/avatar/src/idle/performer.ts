import type { CharacterEmotion, CharacterGesture, GazeTarget } from '@latentpresence/protocol';
import type { Vec3 } from '../gaze';
import type { BoneRotations, LifeBone } from '../life/life';

/**
 * Her idle activities, performed (P6-T01, ADR-50): what core's planner chose, as a body.
 *
 * Pure and three-free, stepped by `update` like `LifeLayer` and `CuePerformer`, so every pose is
 * tested in node. It returns rotations to add, where to look and how open her eyes and mouth
 * are; gestures and emotes go through the `CuePerformer` the call already has (`cues`).
 *
 * **A prop is behind her** (the stage's back wall, z −2.2, and the desk at her back right), so a
 * look at one is a turn over the shoulder: hips, spine, chest, neck and head share at most
 * `MAX_TURN` and the eyes find the rest — never a whole-body spin over feet that do not move.
 *
 * Sign conventions are the life layer's: towards her left is +Y, looking up is −X, leaning back
 * is −X, the left arm rises with +Z and the right with −Z.
 */

/** Things in the room she can look at. Positions in world metres (`STAGE_PROPS`). */
export type IdleProp = 'window' | 'whiteboard' | 'screen' | 'desk';
export type IdlePose = 'turn' | 'stretch' | 'sway' | 'sigh' | 'yawn' | 'shoulders' | 'doze';

/** One activity, as core's `IdlePerform` plus how long — structurally the same, so it passes as is. */
export interface IdleMove {
  readonly gaze?: GazeTarget | IdleProp;
  readonly gesture?: CharacterGesture;
  readonly emote?: CharacterEmotion;
  readonly pose?: IdlePose;
  readonly durationMs: number;
}

/** Where each prop's middle is: the stage's own layout (`vrm/stage.ts`, ADR-49). */
export const STAGE_PROPS: Readonly<Record<IdleProp, Vec3>> = {
  window: [2.4, 2.0, -2.17],
  whiteboard: [-1.27, 1.45, -2.17],
  screen: [1.27, 1.45, -2.17],
  desk: [-1.15, 0.76, -0.95],
};

/**
 * The most her body turns for a look over the shoulder, radians (60°). At 110° (the first try, in
 * the Browser pane) the camera saw the back of her head — on a call, turning her back on them —
 * and the hair's spring bones flailed. 60° and the eyes read as a glance back at it.
 */
export const MAX_TURN = (60 * Math.PI) / 180;
/** How a turn is shared, spine to head; sums to 1. Not the hips: they slide over feet that stay put. */
const TURN_SHARE: readonly [LifeBone, number][] = [
  ['spine', 0.2],
  ['chest', 0.2],
  ['upperChest', 0.1],
  ['neck', 0.2],
  ['head', 0.3],
];

export const IDLE_EASE_IN_MS = 700;
/** A turn eases in slower, so the hair follows rather than flies (seen in the pane). */
export const IDLE_TURN_EASE_IN_MS = 1400;
export const IDLE_EASE_OUT_MS = 700;
/** Someone spoke or typed: back to them, quickly. */
export const IDLE_INTERRUPT_MS = 250;

export interface IdleFrame {
  /** Added on top of the life layer's pose, scaled by the envelope. */
  readonly additive: BoneRotations;
  /** A gaze target for `LifeLayer.setGazeBase` while it runs; null is the user. */
  readonly gazeBase: GazeTarget | null;
  /** A world point the eyes should find (a prop); null leaves the gaze to the life layer. */
  readonly lookAt: Vec3 | null;
  /** 0 open, 1 shut: taken with the life layer's blink, the larger wins. */
  readonly eyesClosed: number;
  /** The jaw, 0..1, for a yawn (the `aa` viseme). */
  readonly mouthOpen: number;
  /** Set on the frame it starts, for the call's `CuePerformer`. */
  readonly cues: { readonly gesture: CharacterGesture | null; readonly emote: CharacterEmotion | null } | null;
  /** True on the frame it finished (or eased out after an interrupt). */
  readonly ended: boolean;
}

const IDLE_FRAME: IdleFrame = { additive: {}, gazeBase: null, lookAt: null, eyesClosed: 0, mouthOpen: 0, cues: null, ended: false };

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function isProp(gaze: IdleMove['gaze']): gaze is IdleProp {
  return gaze === 'window' || gaze === 'whiteboard' || gaze === 'screen' || gaze === 'desk';
}

/** How far round, and how far up, a prop is from her head: her yaw (+ left) and pitch (+ up). */
export function propAngles(prop: Vec3, head: Vec3): { readonly yaw: number; readonly pitch: number } {
  const dx = prop[0] - head[0];
  const dz = prop[2] - head[2];
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(prop[1] - head[1], Math.hypot(dx, dz)) };
}

function add(rotations: Partial<Record<LifeBone, [number, number, number]>>, bone: LifeBone, x: number, y: number, z: number): void {
  const at = rotations[bone] ?? [0, 0, 0];
  rotations[bone] = [at[0] + x, at[1] + y, at[2] + z];
}

/** A pose at time `t` of `duration` ms, before the envelope. Exported for the tests. */
export function posePerform(pose: IdlePose, t: number, duration: number, turn: { readonly yaw: number; readonly pitch: number }): { rotations: BoneRotations; eyesClosed: number; mouthOpen: number } {
  const r: Partial<Record<LifeBone, [number, number, number]>> = {};
  let eyesClosed = 0;
  let mouthOpen = 0;
  const phase = duration <= 0 ? 1 : t / duration;
  switch (pose) {
    case 'turn': {
      const yaw = Math.max(-MAX_TURN, Math.min(MAX_TURN, turn.yaw));
      for (const [bone, share] of TURN_SHARE) add(r, bone, 0, yaw * share, 0);
      // Up or down, in the neck and head only; looking up is −X.
      add(r, 'neck', -turn.pitch * 0.4, 0, 0);
      add(r, 'head', -turn.pitch * 0.6, 0, 0);
      break;
    }
    case 'stretch': {
      // Arms up and out, a lean back, the head with them; most of it at the middle of the stretch.
      const reach = Math.sin(Math.PI * Math.min(1, phase * 1.15));
      add(r, 'leftUpperArm', 0, 0, 1.9 * reach);
      add(r, 'rightUpperArm', 0, 0, -1.9 * reach);
      add(r, 'leftLowerArm', 0, 0.35 * reach, 0);
      add(r, 'rightLowerArm', 0, -0.35 * reach, 0);
      add(r, 'chest', -0.12 * reach, 0, 0);
      add(r, 'head', -0.18 * reach, 0, 0);
      eyesClosed = 0.6 * reach;
      break;
    }
    case 'sway': {
      const swing = Math.sin((2 * Math.PI * t) / 2400);
      add(r, 'hips', 0, 0, 0.035 * swing);
      add(r, 'spine', 0, 0, -0.03 * swing);
      add(r, 'head', 0, 0, 0.06 * swing);
      break;
    }
    case 'sigh': {
      // In, then out and down.
      const breathIn = phase < 0.4 ? Math.sin((Math.PI / 2) * (phase / 0.4)) : Math.cos((Math.PI / 2) * ((phase - 0.4) / 0.6));
      const down = phase < 0.4 ? 0 : Math.sin(Math.PI * ((phase - 0.4) / 0.6));
      add(r, 'chest', -0.05 * breathIn + 0.04 * down, 0, 0);
      add(r, 'leftShoulder', 0, 0, 0.1 * breathIn);
      add(r, 'rightShoulder', 0, 0, -0.1 * breathIn);
      add(r, 'head', 0.12 * down, 0, 0);
      eyesClosed = 0.5 * down;
      break;
    }
    case 'yawn': {
      const open = Math.sin(Math.PI * phase);
      add(r, 'head', -0.22 * open, 0, 0);
      add(r, 'neck', -0.08 * open, 0, 0);
      add(r, 'chest', -0.05 * open, 0, 0);
      mouthOpen = 0.85 * open;
      eyesClosed = 0.85 * open;
      break;
    }
    case 'shoulders': {
      // Two rolls: up and back, then down.
      const roll = Math.max(0, Math.sin((2 * Math.PI * 2 * t) / Math.max(1, duration)));
      add(r, 'leftShoulder', 0, -0.08 * roll, 0.14 * roll);
      add(r, 'rightShoulder', 0, 0.08 * roll, -0.14 * roll);
      break;
    }
    case 'doze': {
      // The head drops, slowly; once, late, it comes up with a start and settles again.
      const start = 0.7;
      const drop = phase < start ? smoothstep(phase / 0.4) : 1 - Math.sin(Math.PI * Math.min(1, (phase - start) / 0.12)) * 0.7;
      add(r, 'head', 0.32 * drop, 0, 0.05 * drop);
      add(r, 'neck', 0.12 * drop, 0, 0);
      add(r, 'chest', 0.05 * drop, 0, 0);
      eyesClosed = Math.min(1, drop * 1.1);
      break;
    }
  }
  return { rotations: r, eyesClosed, mouthOpen };
}

export class IdlePerformer {
  private readonly props: Readonly<Record<IdleProp, Vec3>>;
  private move: IdleMove | null = null;
  private t = 0;
  private startedFrame = false;
  /** Set by `interrupt`: the envelope's value then, and how far through the ease-out. */
  private stopping: { from: number; t: number } | null = null;

  constructor(props: Readonly<Record<IdleProp, Vec3>> = STAGE_PROPS) {
    this.props = props;
  }

  get active(): boolean {
    return this.move !== null;
  }

  /** Begin an activity; one already running is replaced at once. */
  start(move: IdleMove): void {
    this.move = move;
    this.t = 0;
    this.startedFrame = true;
    this.stopping = null;
  }

  /** Someone spoke or typed: ease back over `IDLE_INTERRUPT_MS` from wherever she is. */
  interrupt(): void {
    if (this.move === null || this.stopping !== null) return;
    this.stopping = { from: this.envelope(), t: 0 };
  }

  private envelope(): number {
    const duration = this.move?.durationMs ?? 0;
    const into = smoothstep(this.t / (this.move?.pose === 'turn' ? IDLE_TURN_EASE_IN_MS : IDLE_EASE_IN_MS));
    const out = smoothstep((duration - this.t) / IDLE_EASE_OUT_MS);
    return Math.min(into, out);
  }

  /** `head` is where her head is in the world, for the angle to a prop. */
  update(deltaMs: number, head: Vec3): IdleFrame {
    const move = this.move;
    if (move === null) return IDLE_FRAME;
    this.t += deltaMs;
    let level: number;
    let ended = false;
    if (this.stopping !== null) {
      this.stopping.t += deltaMs;
      level = this.stopping.from * (1 - smoothstep(this.stopping.t / IDLE_INTERRUPT_MS));
      ended = this.stopping.t >= IDLE_INTERRUPT_MS;
    } else {
      level = this.envelope();
      ended = this.t >= move.durationMs;
    }
    const prop = isProp(move.gaze) ? this.props[move.gaze] : null;
    const turn = prop === null ? { yaw: 0, pitch: 0 } : propAngles(prop, head);
    const shape = move.pose === undefined ? { rotations: {}, eyesClosed: 0, mouthOpen: 0 } : posePerform(move.pose, this.t, move.durationMs, turn);
    const additive: Partial<Record<LifeBone, Vec3>> = {};
    for (const [bone, rotation] of Object.entries(shape.rotations) as [LifeBone, Vec3][]) {
      additive[bone] = [rotation[0] * level, rotation[1] * level, rotation[2] * level];
    }
    const cues = this.startedFrame ? { gesture: move.gesture ?? null, emote: move.emote ?? null } : null;
    this.startedFrame = false;
    const frame: IdleFrame = {
      additive,
      gazeBase: prop === null && move.gaze !== undefined && level > 0.5 ? (move.gaze as GazeTarget) : null,
      lookAt: prop !== null && level > 0.3 ? prop : null,
      eyesClosed: shape.eyesClosed * level,
      mouthOpen: shape.mouthOpen * level,
      cues,
      ended,
    };
    if (ended) {
      this.move = null;
      this.stopping = null;
    }
    return frame;
  }
}
