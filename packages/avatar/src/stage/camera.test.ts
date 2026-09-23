import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../gaze';
import { CameraRig, DEFAULT_FOV_DEGREES, type Body, type CameraPreset, frameTop, framing } from './camera';

/** A standing person's proportions, roughly, at the origin. */
const BODY: Body = {
  x: 0,
  z: 0,
  head: 1.45,
  top: 1.68,
  eyes: 1.52,
  upperChest: 1.3,
  chest: 1.25,
  hips: 0.9,
  leftFoot: 0,
  rightFoot: 0,
};

const PRESETS: readonly CameraPreset[] = ['face', 'bust', 'medium', 'full'];

/**
 * Whether a point is inside the vertical FOV **as the camera actually points** — the angle
 * between camera→target and camera→point. The first version measured offsets from the
 * target's height, ignored the tilt, and passed while the crown was cropped.
 */
function inView(position: Vec3, target: Vec3, pointY: number, fovDegrees: number): boolean {
  const pitch = Math.atan2(target[1] - position[1], position[2] - target[2]);
  const toPoint = Math.atan2(pointY - position[1], position[2] - target[2]);
  return Math.abs(toPoint - pitch) <= (fovDegrees * Math.PI) / 360 + 1e-9;
}

describe('framing', () => {
  it('keeps the crown and the bottom of each preset in view, tilt included', () => {
    for (const preset of PRESETS) {
      const { position, target } = framing(preset, BODY);
      const bottom =
        preset === 'face' ? BODY.head - 0.12 : preset === 'bust' ? BODY.upperChest! : preset === 'medium' ? BODY.hips! : 0;
      expect(inView(position, target, BODY.top!, DEFAULT_FOV_DEGREES)).toBe(true);
      expect(inView(position, target, bottom, DEFAULT_FOV_DEGREES)).toBe(true);
    }
  });

  it('frames to the model top, not the head bone, which sits well below the crown', () => {
    expect(frameTop(BODY)).toBeGreaterThan(BODY.top!);
    // With no bounding box the crown is estimated above the bone, never at it.
    expect(frameTop({ ...BODY, top: null })).toBeGreaterThan(BODY.head + 0.2);
  });

  it('moves the camera further back as the framed span grows', () => {
    const distances = PRESETS.map((preset) => framing(preset, BODY).position[2]);
    expect(distances[0]).toBeLessThan(distances[1] as number);
    expect(distances[1]).toBeLessThan(distances[2] as number);
    expect(distances[2]).toBeLessThan(distances[3] as number);
  });

  it('centres the target on the framed span', () => {
    const bust = framing('bust', BODY);
    expect(bust.target[1]).toBeCloseTo((frameTop(BODY) + BODY.upperChest!) / 2, 5);

    const full = framing('full', BODY);
    expect(full.target[1]).toBeCloseTo((frameTop(BODY) + 0) / 2, 5);
  });

  it('puts the camera on +Z of the character, who faces +Z', () => {
    for (const preset of PRESETS) {
      const { position } = framing(preset, BODY);
      expect(position[2]).toBeGreaterThan(BODY.z);
    }
  });

  it('falls back when a preset\'s named bone is missing', () => {
    const noChestOrHips: Body = { ...BODY, upperChest: null, chest: null, hips: null };
    // Still frames something sensible rather than throwing or collapsing to zero span.
    expect(framing('bust', noChestOrHips).position[2]).toBeGreaterThan(0);
    expect(framing('medium', noChestOrHips).position[2]).toBeGreaterThan(0);
  });

  it('puts the camera at the eyes for face and bust, and level at the centre for medium and full', () => {
    expect(framing('face', BODY).position[1]).toBeCloseTo(BODY.eyes!, 5);
    expect(framing('bust', BODY).position[1]).toBeCloseTo(BODY.eyes!, 5);
    for (const preset of ['medium', 'full'] as const) {
      const { position, target } = framing(preset, BODY);
      expect(position[1]).toBeCloseTo(target[1], 5);
    }
  });
});

const IDENTITY: Vec3 = [0, 1.4, 1.6];
const A = { position: IDENTITY, target: [0, 1.35, 0] as Vec3 };
const B = { position: [0, 1.4, 0.8] as Vec3, target: [0, 1.35, 0] as Vec3 };

describe('CameraRig', () => {
  it('reaches the goal exactly at transitionMs', () => {
    const rig = new CameraRig(A);
    rig.setGoal(B, 700);
    rig.update(700);
    expect(rig.update(0)).toEqual(B);
  });

  it('moves only a little on the first frame after setGoal', () => {
    const rig = new CameraRig(A);
    rig.setGoal(B, 700);
    const first = rig.update(16);
    const totalMove = Math.abs(first.position[2] - A.position[2]);
    const fullMove = Math.abs(B.position[2] - A.position[2]);
    expect(totalMove).toBeLessThan(fullMove * 0.1);
  });

  it('starts a new goal from the current pose, not the old goal, so there is no jump', () => {
    const rig = new CameraRig(A);
    rig.setGoal(B, 700);
    const midway = rig.update(350);
    const otherGoal = { position: [0, 1.6, 1.2] as Vec3, target: [0, 1.5, 0] as Vec3 };
    rig.setGoal(otherGoal, 700);
    const next = rig.update(16);
    // A normal 16 ms step moves a small fraction of the 700 ms transition; nothing here
    // should jump anywhere close to the full distance between midway and the new goal.
    const stepDistance = Math.hypot(
      next.position[0] - midway.position[0],
      next.position[1] - midway.position[1],
      next.position[2] - midway.position[2],
    );
    const goalDistance = Math.hypot(
      otherGoal.position[0] - midway.position[0],
      otherGoal.position[1] - midway.position[1],
      otherGoal.position[2] - midway.position[2],
    );
    expect(stepDistance).toBeLessThan(goalDistance * 0.1);
  });

  it('snaps immediately when transitionMs is 0', () => {
    const rig = new CameraRig(A);
    rig.setGoal(B, 0);
    expect(rig.update(0)).toEqual(B);
  });
});
