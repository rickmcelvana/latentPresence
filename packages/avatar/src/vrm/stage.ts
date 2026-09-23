import * as THREE from 'three';

/**
 * The room the character stands in: floor, walls, a window, a desk, and three-point
 * lighting. Three.js, unlike `stage/camera.ts` — three's scene graph needs no WebGL, so
 * `stage.test.ts` runs in node.
 *
 * Built from primitives only. We ship no models (`CLAUDE.md`) and nothing here is
 * downloaded or textured, so there is nothing to put on a consent screen.
 */

export interface StageOptions {
  readonly shadows: boolean;
}

export const DEFAULT_STAGE_OPTIONS: StageOptions = { shadows: true };

/**
 * Every colour the stage uses, in one place — the no-colour-literals rule is about CSS,
 * but scene colours belong together for the same reason: one place to keep them muted
 * and consistent.
 */
export const STAGE_PALETTE = {
  floor: 0x746a5c,
  wall: 0xb8ae9c,
  sideWall: 0xada192,
  windowFrame: 0x3f382e,
  windowPane: 0xb9d3f0,
  deskTop: 0x5a4634,
  deskLeg: 0x2e2419,
  key: 0xfff1d6,
  fill: 0xcfe3ff,
  rim: 0xffffff,
  sky: 0xbfd6ff,
  ground: 0x39332a,
} as const;

/** Roughly where a standing person's feet, hips and shoulders are, for the desk clearance. */
const ROOM_SIZE = 6;
const WALL_HEIGHT = 4;
const BACK_WALL_Z = -2.2;
const SIDE_WALL_X = -3;

function addFloor(group: THREE.Group, shadows: boolean): void {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE),
    new THREE.MeshStandardMaterial({ color: STAGE_PALETTE.floor, roughness: 0.9 }),
  );
  floor.name = 'floor';
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = shadows;
  group.add(floor);
}

function addWalls(group: THREE.Group, shadows: boolean): void {
  const backWall = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_SIZE, WALL_HEIGHT),
    new THREE.MeshStandardMaterial({ color: STAGE_PALETTE.wall, roughness: 0.95 }),
  );
  backWall.name = 'back-wall';
  backWall.position.set(0, WALL_HEIGHT / 2, BACK_WALL_Z);
  backWall.receiveShadow = shadows;
  group.add(backWall);

  const sideWall = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_SIZE, WALL_HEIGHT),
    new THREE.MeshStandardMaterial({ color: STAGE_PALETTE.sideWall, roughness: 0.95 }),
  );
  sideWall.name = 'side-wall';
  sideWall.position.set(SIDE_WALL_X, WALL_HEIGHT / 2, 0);
  sideWall.rotation.y = Math.PI / 2;
  sideWall.receiveShadow = shadows;
  group.add(sideWall);
}

/**
 * A frame plus a bright, emissive pane in the back wall — daylight, not a real hole. It
 * does not need geometry cut from the wall to read as a window.
 */
function addWindow(group: THREE.Group): void {
  const windowGroup = new THREE.Group();
  windowGroup.name = 'window';

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 2, 0.08),
    new THREE.MeshStandardMaterial({ color: STAGE_PALETTE.windowFrame, roughness: 0.7 }),
  );
  frame.name = 'window-frame';
  windowGroup.add(frame);

  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.35, 1.75),
    new THREE.MeshStandardMaterial({
      color: STAGE_PALETTE.windowPane,
      emissive: STAGE_PALETTE.windowPane,
      // At 1.4 the pane clipped to flat white in the Browser pane — a blank slab, not a
      // sky. Under 1 it keeps its blue and still reads as the brightest thing in the room.
      emissiveIntensity: 0.75,
    }),
  );
  pane.name = 'window-pane';
  pane.position.z = 0.05;
  windowGroup.add(pane);

  windowGroup.position.set(1.3, 2, BACK_WALL_Z + 0.03);
  group.add(windowGroup);
}

/**
 * A desk to the character's side and behind her — off the camera's line to her body in
 * every preset, which `stage.test.ts` proves. Every preset's camera and the standing-person
 * points it frames sit at x ≈ 0, so keeping the whole desk off that axis (rather than
 * merely behind the standing-person box) rules out the intersection for any preset, not
 * just the ones measured.
 */
function addDesk(group: THREE.Group, shadows: boolean): void {
  const desk = new THREE.Group();
  desk.name = 'desk';

  const topMaterial = new THREE.MeshStandardMaterial({ color: STAGE_PALETTE.deskTop, roughness: 0.6 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.6), topMaterial);
  top.name = 'desk-top';
  top.position.set(-1.15, 0.73, -0.95);
  top.receiveShadow = shadows;
  desk.add(top);

  const legMaterial = new THREE.MeshStandardMaterial({ color: STAGE_PALETTE.deskLeg, roughness: 0.8 });
  const legGeometry = new THREE.BoxGeometry(0.06, 0.73, 0.06);
  const legOffsets: ReadonlyArray<readonly [number, number]> = [
    [-0.4, -0.26],
    [-0.4, 0.26],
    [0.4, -0.26],
    [0.4, 0.26],
  ];
  legOffsets.forEach(([dx, dz], index) => {
    const leg = new THREE.Mesh(legGeometry, legMaterial);
    leg.name = `desk-leg-${index}`;
    leg.position.set(-1.15 + dx, 0.365, -0.95 + dz);
    desk.add(leg);
  });

  group.add(desk);
}

/**
 * `key`, `fill`, `rim`: warm front-left, cooler front-right and weaker, and a plain rim
 * behind and above to separate her from the wall — plus a low hemisphere so nothing goes
 * fully black, which MToon needs. Facing +Z, the character's left is +X (`gaze.ts`).
 */
function addLights(group: THREE.Group, shadows: boolean): void {
  const key = new THREE.DirectionalLight(STAGE_PALETTE.key, 2.2);
  key.name = 'key';
  key.position.set(1.1, 2.6, 2.0);
  key.castShadow = shadows;
  key.shadow.mapSize.set(1024, 1024);
  // Fitted tightly around a standing person, not three.js's default (huge) frustum.
  const shadowCamera = key.shadow.camera;
  shadowCamera.left = -0.8;
  shadowCamera.right = 0.8;
  shadowCamera.top = 2.2;
  shadowCamera.bottom = -0.1;
  shadowCamera.near = 0.5;
  shadowCamera.far = 6;
  shadowCamera.updateProjectionMatrix();
  group.add(key);

  const fill = new THREE.DirectionalLight(STAGE_PALETTE.fill, 0.7);
  fill.name = 'fill';
  fill.position.set(-1.4, 1.8, 1.6);
  fill.castShadow = false;
  group.add(fill);

  const rim = new THREE.DirectionalLight(STAGE_PALETTE.rim, 0.9);
  rim.name = 'rim';
  rim.position.set(0, 2.6, -1.8);
  rim.castShadow = false;
  group.add(rim);

  const hemisphere = new THREE.HemisphereLight(STAGE_PALETTE.sky, STAGE_PALETTE.ground, 0.4);
  hemisphere.name = 'hemisphere';
  group.add(hemisphere);
}

/**
 * The room and its lighting as one `THREE.Group`, added to the renderer's scene. Every
 * part is named so tests and the debug panel can find it.
 */
export function buildStage(options: StageOptions = DEFAULT_STAGE_OPTIONS): THREE.Group {
  const group = new THREE.Group();
  group.name = 'stage';

  addFloor(group, options.shadows);
  addWalls(group, options.shadows);
  addWindow(group);
  addDesk(group, options.shadows);
  addLights(group, options.shadows);

  return group;
}
