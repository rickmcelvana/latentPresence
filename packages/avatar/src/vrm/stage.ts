import * as THREE from 'three';
import { DisplayBoard, type CreateCanvas } from './display-board';

/**
 * The room the character stands in: floor, walls, a window, a desk, a whiteboard and a
 * screen, and three-point lighting. Three.js, unlike `stage/camera.ts` — three's scene graph
 * needs no WebGL, so `stage.test.ts` runs in node.
 *
 * Built from primitives only. We ship no models (`CLAUDE.md`) and nothing here is
 * downloaded; the two boards are canvas-drawn text (P5-T08, ADR-49), so there is nothing to
 * put on a consent screen.
 */

export interface StageOptions {
  readonly shadows: boolean;
}

/**
 * What the stage needs from its host. `createCanvas` makes the boards' drawing surfaces;
 * without it (node) the boards are plain materials and nothing is drawn.
 */
export interface StageDeps {
  readonly createCanvas?: CreateCanvas | undefined;
}

/** The two boards' drawing, for the renderer to put content on. */
export interface StageBoards {
  readonly whiteboard: DisplayBoard;
  readonly screen: DisplayBoard;
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
  boardWhite: 0xf4f6f4,
  boardFrame: 0x8d949a,
  markerInk: 0x22303a,
  markerAccent: 0x0d9488,
  markerMuted: 0x7d8a92,
  bezel: 0x15191c,
  screenBackground: 0x10181c,
  screenOff: 0x07090a,
  screenText: 0xe6eef0,
  screenAccent: 0x2dd4bf,
  screenMuted: 0x8fa3a8,
} as const;

/** Roughly where a standing person's feet, hips and shoulders are, for the desk clearance. */
const ROOM_SIZE = 6;
const WALL_HEIGHT = 4;
const BACK_WALL_Z = -2.2;
const SIDE_WALL_X = -3;

/** Things on the back wall stand this far off it, as the window does. */
const WALL_FACE_Z = BACK_WALL_Z + 0.03;

/**
 * Where the boards and the window hang on the back wall (ADR-49, measured against the
 * `medium` framing: the wall is seen at x ±1.89 m at 16:9, ±1.70 at 16:10, ±1.42 at 4:3, and
 * her standing box hides x ±0.77 behind her).
 */
export const WHITEBOARD = { x: -1.27, y: 1.45, width: 0.84, height: 0.62, frame: 0.02, depth: 0.02 } as const;
export const SCREEN = { x: 1.27, y: 1.45, width: 0.84, height: 0.5, bezel: 0.03, depth: 0.03 } as const;
export const WINDOW = { x: 2.4, y: 2, width: 1.1, height: 2, paneWidth: 0.85, paneHeight: 1.75 } as const;

/** Texture width in pixels; the height follows the surface's aspect. */
const BOARD_TEXTURE_WIDTH = 1024;
const BOARD_PADDING_M = 0.03;

const boards = new WeakMap<THREE.Group, StageBoards>();

/** The boards of a stage `buildStage` made, or null for any other group. */
export function stageBoards(stage: THREE.Object3D | null | undefined): StageBoards | null {
  return stage instanceof THREE.Group ? (boards.get(stage) ?? null) : null;
}

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
    new THREE.BoxGeometry(WINDOW.width, WINDOW.height, 0.08),
    new THREE.MeshStandardMaterial({ color: STAGE_PALETTE.windowFrame, roughness: 0.7 }),
  );
  frame.name = 'window-frame';
  windowGroup.add(frame);

  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(WINDOW.paneWidth, WINDOW.paneHeight),
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

  windowGroup.position.set(WINDOW.x, WINDOW.y, WALL_FACE_Z);
  group.add(windowGroup);
}

/**
 * A flat panel on the back wall: a frame (or bezel) box with a drawn surface just in front.
 * The surface is named `<name>-surface`; tests and the debug panel find both by name.
 */
function addPanel(
  group: THREE.Group,
  spec: { readonly name: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly border: number; readonly depth: number },
  frameColour: number,
  surfaceMaterial: THREE.Material,
): void {
  const panel = new THREE.Group();
  panel.name = spec.name;
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(spec.width + 2 * spec.border, spec.height + 2 * spec.border, spec.depth),
    new THREE.MeshStandardMaterial({ color: frameColour, roughness: 0.6 }),
  );
  frame.name = `${spec.name}-frame`;
  panel.add(frame);

  const surface = new THREE.Mesh(new THREE.PlaneGeometry(spec.width, spec.height), surfaceMaterial);
  surface.name = `${spec.name}-surface`;
  surface.position.z = spec.depth / 2 + 0.001;
  panel.add(surface);

  panel.position.set(spec.x, spec.y, WALL_FACE_Z);
  group.add(panel);
}

function boardFor(
  spec: { readonly width: number; readonly height: number },
  palette: { readonly background: number; readonly ink: number; readonly accent: number; readonly muted: number },
  idleBackground: number,
  createCanvas: CreateCanvas | undefined,
): DisplayBoard {
  const pixelsPerMetre = BOARD_TEXTURE_WIDTH / spec.width;
  return new DisplayBoard({
    width: BOARD_TEXTURE_WIDTH,
    height: Math.round(spec.height * pixelsPerMetre),
    pixelsPerMetre,
    padding: BOARD_PADDING_M * pixelsPerMetre,
    palette,
    idleBackground,
    createCanvas,
  });
}

/**
 * The whiteboard (left) and the screen (right) on the back wall, either side of her (ADR-49).
 * The whiteboard is lit like the wall; the screen is lit from within — a `MeshBasicMaterial`, so
 * it reads the same under any light.
 */
function addDisplays(group: THREE.Group, createCanvas: CreateCanvas | undefined): StageBoards {
  const whiteboard = boardFor(
    WHITEBOARD,
    { background: STAGE_PALETTE.boardWhite, ink: STAGE_PALETTE.markerInk, accent: STAGE_PALETTE.markerAccent, muted: STAGE_PALETTE.markerMuted },
    STAGE_PALETTE.boardWhite,
    createCanvas,
  );
  const whiteboardMaterial =
    whiteboard.texture === null
      ? new THREE.MeshStandardMaterial({ color: STAGE_PALETTE.boardWhite, roughness: 0.5 })
      : // Lit by the room alone the board read mid-grey and its ink faint (seen at 1080p, P5-T08): a
        // little of its own picture as emission keeps it white without washing out the ink.
        new THREE.MeshStandardMaterial({ map: whiteboard.texture, roughness: 0.5, emissive: 0xffffff, emissiveMap: whiteboard.texture, emissiveIntensity: 0.45 });
  addPanel(group, { name: 'whiteboard', ...WHITEBOARD, border: WHITEBOARD.frame }, STAGE_PALETTE.boardFrame, whiteboardMaterial);

  const screen = boardFor(
    SCREEN,
    { background: STAGE_PALETTE.screenBackground, ink: STAGE_PALETTE.screenText, accent: STAGE_PALETTE.screenAccent, muted: STAGE_PALETTE.screenMuted },
    STAGE_PALETTE.screenOff,
    createCanvas,
  );
  const screenMaterial =
    screen.texture === null ? new THREE.MeshBasicMaterial({ color: STAGE_PALETTE.screenOff }) : new THREE.MeshBasicMaterial({ map: screen.texture });
  addPanel(group, { name: 'screen', ...SCREEN, border: SCREEN.bezel }, STAGE_PALETTE.bezel, screenMaterial);

  return { whiteboard, screen };
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
export function buildStage(options: StageOptions = DEFAULT_STAGE_OPTIONS, deps: StageDeps = {}): THREE.Group {
  const group = new THREE.Group();
  group.name = 'stage';

  addFloor(group, options.shadows);
  addWalls(group, options.shadows);
  addWindow(group);
  addDesk(group, options.shadows);
  boards.set(group, addDisplays(group, deps.createCanvas));
  addLights(group, options.shadows);

  return group;
}
