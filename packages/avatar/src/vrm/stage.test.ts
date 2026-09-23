import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Body, CameraPreset } from '../stage/camera';
import { framing } from '../stage/camera';
import { STAGE_PALETTE, buildStage } from './stage';

const PRESETS: readonly CameraPreset[] = ['face', 'bust', 'medium', 'full'];

/** A standing person at the origin, facing +Z — what every preset frames. */
const STANDARD_BODY: Body = {
  x: 0,
  z: 0,
  head: 1.5,
  top: 1.72,
  eyes: 1.57,
  upperChest: 1.35,
  chest: 1.25,
  hips: 0.9,
  leftFoot: 0,
  rightFoot: 0,
};

const STANDING_PERSON_BOX = new THREE.Box3(new THREE.Vector3(-0.35, 0, -0.3), new THREE.Vector3(0.35, 1.8, 0.3));

function part(stage: THREE.Group, name: string): THREE.Object3D {
  const found = stage.getObjectByName(name);
  if (found === undefined) throw new Error(`stage has no part named "${name}"`);
  return found;
}

/** Whether the segment from `from` to `to` passes through `box`, not just the infinite ray. */
function segmentIntersectsBox(from: THREE.Vector3, to: THREE.Vector3, box: THREE.Box3): boolean {
  const offset = new THREE.Vector3().subVectors(to, from);
  const length = offset.length();
  if (length < 1e-6) return box.containsPoint(from);
  const ray = new THREE.Ray(from, offset.clone().normalize());
  const hit = ray.intersectBox(box, new THREE.Vector3());
  if (hit === null) return false;
  return from.distanceTo(hit) <= length;
}

describe('buildStage', () => {
  it('names every part, so tests and the debug panel can find them', () => {
    const stage = buildStage();
    for (const name of ['floor', 'back-wall', 'side-wall', 'window', 'window-frame', 'window-pane', 'desk', 'desk-top']) {
      expect(() => part(stage, name)).not.toThrow();
    }
  });

  it('names the three lights plus a hemisphere', () => {
    const stage = buildStage();
    expect(part(stage, 'key')).toBeInstanceOf(THREE.DirectionalLight);
    expect(part(stage, 'fill')).toBeInstanceOf(THREE.DirectionalLight);
    expect(part(stage, 'rim')).toBeInstanceOf(THREE.DirectionalLight);
    expect(part(stage, 'hemisphere')).toBeInstanceOf(THREE.HemisphereLight);
  });

  it('makes the key light the only shadow caster, tied to the shadows option', () => {
    for (const shadows of [true, false]) {
      const stage = buildStage({ shadows });
      const key = part(stage, 'key') as THREE.DirectionalLight;
      const fill = part(stage, 'fill') as THREE.DirectionalLight;
      const rim = part(stage, 'rim') as THREE.DirectionalLight;
      expect(key.castShadow).toBe(shadows);
      expect(fill.castShadow).toBe(false);
      expect(rim.castShadow).toBe(false);
    }
  });

  it('fits the key light\'s shadow camera tightly, not three.js\'s default huge frustum', () => {
    const key = part(buildStage(), 'key') as THREE.DirectionalLight;
    const camera = key.shadow.camera;
    expect(camera.right - camera.left).toBeLessThan(3);
    expect(camera.top - camera.bottom).toBeLessThan(4);
  });

  it('keeps the desk clear of a standing person, in the character\'s x/z as much as behind her', () => {
    const desk = part(buildStage(), 'desk');
    const box = new THREE.Box3().setFromObject(desk);
    expect(box.intersectsBox(STANDING_PERSON_BOX)).toBe(false);
  });

  it('never puts the desk between any preset\'s camera and her head, hips or feet', () => {
    const desk = part(buildStage(), 'desk');
    const box = new THREE.Box3().setFromObject(desk);
    const targets = [
      new THREE.Vector3(0, STANDARD_BODY.head, 0),
      new THREE.Vector3(0, STANDARD_BODY.hips ?? 0.9, 0),
      new THREE.Vector3(0, STANDARD_BODY.leftFoot ?? 0, 0),
    ];

    for (const preset of PRESETS) {
      const { position } = framing(preset, STANDARD_BODY);
      const cameraPoint = new THREE.Vector3(position[0], position[1], position[2]);
      for (const target of targets) {
        expect(segmentIntersectsBox(cameraPoint, target, box)).toBe(false);
      }
    }
  });

  it('keeps every colour in one exported palette', () => {
    expect(Object.keys(STAGE_PALETTE).length).toBeGreaterThan(5);
    for (const value of Object.values(STAGE_PALETTE)) {
      expect(typeof value).toBe('number');
    }
  });
});
