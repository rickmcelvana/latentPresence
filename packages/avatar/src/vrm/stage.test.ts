import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Body, CameraPreset } from '../stage/camera';
import { framing } from '../stage/camera';
import { BOARD_TEXT } from '../stage/displays';
import { STAGE_PALETTE, buildStage, stageBoards } from './stage';

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

const FRAME_SIZES: readonly (readonly [number, number])[] = [
  [1920, 1080],
  [1920, 1200],
];

/** The `medium` preset's camera on the standard body, for a frame of this size. */
function mediumCamera(width: number, height: number): THREE.PerspectiveCamera {
  const { position, target } = framing('medium', STANDARD_BODY, 30);
  const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(target[0], target[1], target[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/** The surface's four corners, in world space. */
function surfaceCorners(stage: THREE.Group, name: string): THREE.Vector3[] {
  const surface = part(stage, name) as THREE.Mesh;
  surface.updateWorldMatrix(true, false);
  const geometry = surface.geometry as THREE.PlaneGeometry;
  const { width, height } = geometry.parameters;
  return [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([x, y]) => new THREE.Vector3((x ?? 0) * width, (y ?? 0) * height, 0).applyMatrix4(surface.matrixWorld));
}

function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  return [min.x, max.x].flatMap((x) => [min.y, max.y].flatMap((y) => [min.z, max.z].map((z) => new THREE.Vector3(x, y, z))));
}

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

/** The rectangle the points cover on screen, in NDC. */
function projectedRect(points: readonly THREE.Vector3[], camera: THREE.Camera): Rect {
  const projected = points.map((point) => point.clone().project(camera));
  return {
    left: Math.min(...projected.map((point) => point.x)),
    right: Math.max(...projected.map((point) => point.x)),
    bottom: Math.min(...projected.map((point) => point.y)),
    top: Math.max(...projected.map((point) => point.y)),
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;
}

/** An NDC rectangle in pixels of a frame, from the top left. */
function pixels(rect: Rect, width: number, height: number): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.round(((rect.left + 1) / 2) * width),
    top: Math.round(((1 - rect.top) / 2) * height),
    width: Math.round(((rect.right - rect.left) / 2) * width),
    height: Math.round(((rect.top - rect.bottom) / 2) * height),
  };
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

  it('names the whiteboard and the screen, each with its surface', () => {
    const stage = buildStage();
    for (const name of ['whiteboard', 'whiteboard-surface', 'screen', 'screen-surface']) {
      expect(() => part(stage, name)).not.toThrow();
    }
  });

  it('draws nothing without a canvas: plain materials, no textures', () => {
    const stage = buildStage();
    expect(stageBoards(stage)?.whiteboard.texture).toBeNull();
    expect(((part(stage, 'whiteboard-surface') as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBeNull();
    expect(((part(stage, 'screen-surface') as THREE.Mesh).material as THREE.MeshBasicMaterial).map).toBeNull();
  });

  it('lights the screen from within: a basic material, the same under any light', () => {
    const material = (part(buildStage(), 'screen-surface') as THREE.Mesh).material;
    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it('makes each board a sRGB canvas texture with mipmaps when it has a canvas', () => {
    const calls: [number, number][] = [];
    const stage = buildStage(undefined, {
      createCanvas: (width, height) => {
        calls.push([width, height]);
        return { width, height, getContext: () => null };
      },
    });
    // A canvas with no 2D context is as good as none: the board falls back to plain materials.
    expect(calls).toEqual([
      [1024, 756],
      [1024, 610],
    ]);
    expect(stageBoards(stage)?.screen.texture).toBeNull();
  });

  it('keeps every colour in one exported palette', () => {
    expect(Object.keys(STAGE_PALETTE).length).toBeGreaterThan(5);
    for (const value of Object.values(STAGE_PALETTE)) {
      expect(typeof value).toBe('number');
    }
  });

  describe.each(FRAME_SIZES)('readable at the medium preset, %i x %i', (width, height) => {
    const camera = mediumCamera(width, height);
    const stage = buildStage();
    // Her standing box, on her own plane (z = 0) — as ADR-49 measured it (x ±0.35 m hides ±0.77 m of
    // the wall). The box's near face (z = +0.3, a desk-clearance margin, not her body) would reach
    // x ±0.93 m on the wall and take the boards' inner edges (±0.85 m).
    const person = projectedRect(
      boxCorners(new THREE.Box3(new THREE.Vector3(STANDING_PERSON_BOX.min.x, STANDING_PERSON_BOX.min.y, 0), new THREE.Vector3(STANDING_PERSON_BOX.max.x, STANDING_PERSON_BOX.max.y, 0))),
      camera,
    );
    const window = projectedRect(boxCorners(new THREE.Box3().setFromObject(part(stage, 'window'))), camera);

    it.each(['whiteboard-surface', 'screen-surface'])('keeps %s in frame, clear of her and of the window', (name) => {
      const corners = surfaceCorners(stage, name);
      for (const corner of corners) {
        const ndc = corner.clone().project(camera);
        expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
      }
      const rect = projectedRect(corners, camera);
      expect(overlaps(rect, person)).toBe(false);
      expect(overlaps(rect, window)).toBe(false);
    });

    it('keeps the two boards clear of each other', () => {
      expect(overlaps(projectedRect(surfaceCorners(stage, 'whiteboard-surface'), camera), projectedRect(surfaceCorners(stage, 'screen-surface'), camera))).toBe(false);
    });
  });

  it('projects body text at least 16 px tall on both boards at 1080p', () => {
    const camera = mediumCamera(1920, 1080);
    const stage = buildStage();
    for (const name of ['whiteboard-surface', 'screen-surface']) {
      const centre = new THREE.Vector3();
      part(stage, name).getWorldPosition(centre);
      const top = centre.clone().add(new THREE.Vector3(0, BOARD_TEXT.body / 2, 0)).project(camera);
      const bottom = centre.clone().add(new THREE.Vector3(0, -BOARD_TEXT.body / 2, 0)).project(camera);
      const tall = ((top.y - bottom.y) / 2) * 1080;
      expect(tall).toBeGreaterThanOrEqual(16);
    }
  });

  it('lands the boards where ADR-49 measured them at 1080p (about 430 x 300 px each, either side of her)', () => {
    const camera = mediumCamera(1920, 1080);
    const stage = buildStage();
    const whiteboard = pixels(projectedRect(surfaceCorners(stage, 'whiteboard-surface'), camera), 1920, 1080);
    const screen = pixels(projectedRect(surfaceCorners(stage, 'screen-surface'), camera), 1920, 1080);
    expect(whiteboard.left).toBeLessThan(960 - whiteboard.width);
    expect(screen.left).toBeGreaterThan(960);
    for (const board of [whiteboard, screen]) {
      expect(board.width).toBeGreaterThan(400);
      expect(board.height).toBeGreaterThan(250);
    }
  });

  it('moves the window right, clear of the screen', () => {
    const stage = buildStage();
    const window = new THREE.Box3().setFromObject(part(stage, 'window'));
    const screen = new THREE.Box3().setFromObject(part(stage, 'screen'));
    expect(window.min.x).toBeGreaterThan(screen.max.x);
    expect(window.max.x - window.min.x).toBeCloseTo(1.1, 2);
  });
});
