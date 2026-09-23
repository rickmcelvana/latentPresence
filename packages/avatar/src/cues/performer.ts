import type { CharacterEmotion, CharacterGesture, ExpressionName, ExpressionWeights, InlineTag } from '@latentpresence/protocol';
import type { Vec3 } from '../gaze';
import type { BoneRotations, LifeBone, LifePose } from '../life';
import { EMOTION_EXPRESSIONS } from '../mappings/emotions';
import { GESTURE_MOTIONS, type GestureMotion } from '../mappings/gestures';

/** How fast the face follows a new emote, and how slowly it lets one go. */
export const EXPRESSION_ATTACK_MS = 120;
export const EXPRESSION_RELEASE_MS = 450;

/** A life pose with a gesture's rotations added to its additive layer. */
export function withGesture(pose: LifePose, extra: BoneRotations): LifePose {
  if (Object.keys(extra).length === 0) return pose;
  const additive: Partial<Record<LifeBone, Vec3>> = { ...pose.additive };
  for (const [bone, rotation] of Object.entries(extra) as [LifeBone, Vec3][]) {
    const base = additive[bone] ?? [0, 0, 0];
    additive[bone] = [base[0] + rotation[0], base[1] + rotation[1], base[2] + rotation[2]];
  }
  return { ...pose, additive };
}

export type PerformResult = 'performed' | 'unmapped';

export interface PerformerFrame {
  readonly expression: ExpressionWeights;
  /** Added to the life layer's additive pose; empty when no gesture runs. */
  readonly additive: BoneRotations;
}

/**
 * Plays tags on the face and body (P2-T07): an emote eases the face to its expression and
 * holds it until the next emote or `release`; a gesture runs its motion once, on top of
 * anything else, and several can overlap (a nod during a lean-in). Pure and stepped by
 * `update`, like `LifeLayer`, so every envelope is tested by advancing time in node.
 */
export class CuePerformer {
  private current: Partial<Record<ExpressionName, number>> = {};
  private target: ExpressionWeights = {};
  private running: { motion: GestureMotion; t: number }[] = [];

  perform(tag: InlineTag): PerformResult {
    if (tag.known === null) return 'unmapped';
    if (tag.kind === 'emote') {
      const weights = EMOTION_EXPRESSIONS[tag.known as CharacterEmotion] as ExpressionWeights | undefined;
      if (weights === undefined) return 'unmapped';
      this.target = weights;
      return 'performed';
    }
    const motion = GESTURE_MOTIONS[tag.known as CharacterGesture] as GestureMotion | null | undefined;
    if (motion === null || motion === undefined) return 'unmapped';
    this.running.push({ motion, t: 0 });
    return 'performed';
  }

  /** Let the face go back to neutral; running gestures finish on their own. */
  release(): void {
    this.target = {};
  }

  update(deltaMs: number): PerformerFrame {
    const names = new Set([...Object.keys(this.current), ...Object.keys(this.target)] as ExpressionName[]);
    const next: Partial<Record<ExpressionName, number>> = {};
    for (const name of names) {
      const from = this.current[name] ?? 0;
      const to = this.target[name] ?? 0;
      const tau = to > from ? EXPRESSION_ATTACK_MS : EXPRESSION_RELEASE_MS;
      const value = from + (to - from) * (1 - Math.exp(-deltaMs / tau));
      // Below a hundredth nobody can see it; dropping it keeps the weights map small.
      if (value > 0.01 || to > 0) next[name] = value;
    }
    this.current = next;

    const additive: Partial<Record<LifeBone, Vec3>> = {};
    for (const gesture of this.running) {
      gesture.t += deltaMs;
      for (const [bone, rotation] of Object.entries(gesture.motion.pose(gesture.t)) as [LifeBone, Vec3][]) {
        const sum = additive[bone] ?? [0, 0, 0];
        additive[bone] = [sum[0] + rotation[0], sum[1] + rotation[1], sum[2] + rotation[2]];
      }
    }
    this.running = this.running.filter((gesture) => gesture.t < gesture.motion.durationMs);
    return { expression: { ...next }, additive };
  }
}
