import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { LifeBone } from '../life';
import { AdditivePose } from './additive-pose';
import { ClipPlayer } from './clip-player';

function rig(): { root: THREE.Object3D; bones: Map<LifeBone, THREE.Object3D>; pose: AdditivePose } {
  const root = new THREE.Object3D();
  const bones = new Map<LifeBone, THREE.Object3D>();
  for (const name of ['hips', 'spine', 'head'] as const) {
    const bone = new THREE.Object3D();
    bone.name = name;
    root.add(bone);
    bones.set(name, bone);
  }
  return { root, bones, pose: new AdditivePose((bone) => bones.get(bone) ?? null) };
}

describe('AdditivePose', () => {
  it('restores a bone exactly to what it held before', () => {
    const { bones, pose } = rig();
    const head = bones.get('head') as THREE.Object3D;
    head.quaternion.setFromEuler(new THREE.Euler(0.2, 0.1, 0));
    const before = head.quaternion.clone();
    pose.apply([{ head: [0.05, 0.3, 0] }, { head: [0, 0, 0.1] }], [0.01, 0, 0]);
    expect(head.quaternion.angleTo(before)).toBeGreaterThan(0.1);
    pose.restore();
    expect(head.quaternion.angleTo(before)).toBeLessThan(1e-6);
    expect((bones.get('hips') as THREE.Object3D).position.x).toBeCloseTo(0);
  });

  it('does not accumulate on a bone nothing else writes, over a thousand frames', () => {
    const { bones, pose } = rig();
    const spine = bones.get('spine') as THREE.Object3D;
    for (let i = 0; i < 1000; i += 1) {
      pose.restore();
      pose.apply([{ spine: [0, 0, 0.05] }], [0.01, 0, 0]);
    }
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.05));
    expect(spine.quaternion.angleTo(expected)).toBeLessThan(1e-6);
    expect((bones.get('hips') as THREE.Object3D).position.x).toBeCloseTo(0.01);
  });

  it('lands on top of a clip the mixer writes each frame', () => {
    const { root, bones, pose } = rig();
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.5, 0));
    const track = new THREE.QuaternionKeyframeTrack('head.quaternion', [0, 1], [...turn.toArray(), ...turn.toArray()]);
    const player = new ClipPlayer(root);
    player.add('turn', new THREE.AnimationClip('turn', 1, [track]));
    void player.play('turn', { loop: true, crossfadeMs: 0, weight: 1 });
    expect(player.posing).toBe(true);

    const head = bones.get('head') as THREE.Object3D;
    const nod = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0, 0));
    for (let i = 0; i < 100; i += 1) {
      pose.restore();
      player.update(16);
      pose.apply([{ head: [0.1, 0, 0] }]);
    }
    expect(head.quaternion.angleTo(turn.clone().multiply(nod))).toBeLessThan(1e-5);
  });

  it('skips a bone the rig does not have', () => {
    const { pose } = rig();
    expect(() => pose.apply([{ upperChest: [0.1, 0, 0] }])).not.toThrow();
  });
});
