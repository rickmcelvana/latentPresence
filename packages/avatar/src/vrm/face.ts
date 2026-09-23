import type * as THREE from 'three';
import type { VRMExpressionManager } from '@pixiv/three-vrm';
import type { ExpressionWeights, Viseme } from '@latentpresence/protocol';
import { type ExpressionPlan, resolveExpressionPlan, weightsFor } from '../expressions';
import { MOUTH_SHAPES, type MouthShape, applyViseme } from '../fake';

/**
 * The part of a loaded VRM the face needs. Narrow on purpose: a real `VRM` satisfies it,
 * and so does a bare `VRMExpressionManager` in a test, with no WebGL and no model file.
 */
export interface VrmFace {
  readonly expressionManager?: VRMExpressionManager | undefined;
  readonly lookAt?: { target?: THREE.Object3D | null | undefined } | null | undefined;
}

/**
 * Expressions, mouth and look-at target for one loaded model.
 *
 * Writes weights into three-vrm's expression manager and nothing else — three-vrm applies
 * them in `vrm.update`, after the mixer, so a clip's pose and the face land in one frame.
 * Expressions and mouth are separate channels on purpose: the plan never contains a
 * viseme, so an emotion can never close a mouth that lip sync is holding open.
 */
export class VrmFaceDriver {
  readonly plan: ExpressionPlan;
  private readonly face: VrmFace;
  private mouth = new Map<MouthShape, number>(MOUTH_SHAPES.map((shape) => [shape, 0]));

  constructor(face: VrmFace) {
    this.face = face;
    this.plan = resolveExpressionPlan(Object.keys(face.expressionManager?.expressionMap ?? {}));
  }

  /** The model's own expression names, as the debug panel lists them. */
  get available(): readonly string[] {
    return Object.keys(this.face.expressionManager?.expressionMap ?? {});
  }

  get hasLookAt(): boolean {
    return this.face.lookAt !== null && this.face.lookAt !== undefined;
  }

  setExpression(weights: ExpressionWeights): void {
    const manager = this.face.expressionManager;
    if (manager === undefined) return;
    for (const [name, weight] of weightsFor(this.plan, weights)) manager.setValue(name, weight);
  }

  setViseme(viseme: Viseme, weight: number): void {
    this.mouth = applyViseme(this.mouth, viseme, weight);
    const manager = this.face.expressionManager;
    if (manager === undefined) return;
    // A model without a shape simply has no such key; three-vrm ignores the write.
    for (const [shape, value] of this.mouth) manager.setValue(shape, value);
  }

  /** Points the model's look-at at `target`, which the renderer moves each frame. */
  attachGazeTarget(target: THREE.Object3D): void {
    const lookAt = this.face.lookAt;
    if (lookAt !== null && lookAt !== undefined) lookAt.target = target;
  }
}
