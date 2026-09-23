import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VRMExpression, VRMExpressionManager } from '@pixiv/three-vrm';
import { VrmFaceDriver } from './face';

/** three-vrm's own manager, with the expressions a preset-only model registers. */
function manager(names: readonly string[]): VRMExpressionManager {
  const out = new VRMExpressionManager();
  for (const name of names) out.registerExpression(new VRMExpression(name));
  return out;
}

const PRESET_MODEL = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink'];

describe('VrmFaceDriver', () => {
  it('writes expression weights into three-vrm, including the fallbacks', () => {
    const expressions = manager(PRESET_MODEL);
    const face = new VrmFaceDriver({ expressionManager: expressions });
    face.setExpression({ sad: 0.4, mouthSmile: 1 });
    expect(expressions.getValue('sad')).toBeCloseTo(0.4);
    expect(expressions.getValue('happy')).toBeCloseTo(0.5);
    face.setExpression({});
    expect(expressions.getValue('sad')).toBe(0);
    expect(expressions.getValue('happy')).toBe(0);
  });

  it('never touches the mouth or the blink from the expression channel', () => {
    const expressions = manager(PRESET_MODEL);
    const face = new VrmFaceDriver({ expressionManager: expressions });
    face.setViseme('aa', 0.9);
    expressions.setValue('blink', 0.6);
    face.setExpression({ happy: 1 });
    expect(expressions.getValue('aa')).toBeCloseTo(0.9);
    expect(expressions.getValue('blink')).toBeCloseTo(0.6);
  });

  it('drives visemes as channels and closes them on sil', () => {
    const expressions = manager(PRESET_MODEL);
    const face = new VrmFaceDriver({ expressionManager: expressions });
    face.setViseme('aa', 0.7);
    face.setViseme('oh', 0.2);
    expect(expressions.getValue('aa')).toBeCloseTo(0.7);
    expect(expressions.getValue('oh')).toBeCloseTo(0.2);
    face.setViseme('sil', 1);
    expect(expressions.getValue('aa')).toBe(0);
    expect(expressions.getValue('oh')).toBe(0);
  });

  it('passes ARKit shapes through on a model that has them', () => {
    const expressions = manager([...PRESET_MODEL, 'browInnerUp', 'mouthSmileLeft', 'mouthSmileRight']);
    const face = new VrmFaceDriver({ expressionManager: expressions });
    face.setExpression({ browInnerUp: 0.3, mouthSmile: 0.8 });
    expect(expressions.getValue('browInnerUp')).toBeCloseTo(0.3);
    expect(expressions.getValue('mouthSmileLeft')).toBeCloseTo(0.8);
    expect(expressions.getValue('mouthSmileRight')).toBeCloseTo(0.8);
    // The passthrough exists, so the fallback does not also fire.
    expect(expressions.getValue('happy')).toBe(0);
  });

  it('survives a model with no expressions and no look-at', () => {
    const face = new VrmFaceDriver({});
    expect(() => face.setExpression({ happy: 1 })).not.toThrow();
    expect(() => face.setViseme('aa', 1)).not.toThrow();
    expect(face.hasLookAt).toBe(false);
    expect(() => face.attachGazeTarget(new THREE.Object3D())).not.toThrow();
  });

  it('points the look-at at the target it is given', () => {
    const lookAt: { target?: THREE.Object3D | null } = {};
    const face = new VrmFaceDriver({ lookAt });
    const target = new THREE.Object3D();
    face.attachGazeTarget(target);
    expect(lookAt.target).toBe(target);
  });
});
