import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { type VRM, type VRMHumanBoneName, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import {
  type AvatarCapabilities,
  type AvatarRenderer,
  type CharacterSource,
  CharacterSourceSchema,
  type ClipOptions,
  type ExpressionWeights,
  type GazeTarget,
  type Viseme,
} from '@latentpresence/protocol';
import type { ExpressionPlan } from '../expressions';
import { type GazeOffset, type Vec3, gazePoint } from '../gaze';
import type { LifeBone, LifePose } from '../life';
import { type Body, CameraRig, DEFAULT_FOV_DEGREES, DEFAULT_TRANSITION_MS, type CameraPreset, framing } from '../stage/camera';
import { AdditivePose } from './additive-pose';
import { ClipPlayer } from './clip-player';
import { VrmFaceDriver } from './face';
import { DEFAULT_STAGE_OPTIONS, type StageOptions, buildStage } from './stage';

/**
 * What drawing needs from a WebGL renderer; `THREE.WebGLRenderer` is the real one.
 * `shadowMap` is optional so a fake surface (tests) need not carry one.
 */
export interface DrawingSurface {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
  shadowMap?: { enabled: boolean; type: number };
}

export interface VrmRendererDeps {
  createSurface(canvas: HTMLCanvasElement): DrawingSurface;
  loadGltf(url: string): Promise<GLTF>;
  pixelRatio(): number;
}

function defaultDeps(): VrmRendererDeps {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  return {
    createSurface: (canvas) => {
      const surface = new THREE.WebGLRenderer({ canvas, antialias: true });
      // The default surface enables shadows; the stage's `key` light is the only caster.
      surface.shadowMap.enabled = true;
      surface.shadowMap.type = THREE.PCFSoftShadowMap;
      return surface;
    },
    loadGltf: (url) => loader.loadAsync(url),
    pixelRatio: () => globalThis.devicePixelRatio ?? 1,
  };
}

export interface VrmRendererOptions {
  /** The room and its lighting (P2-T05). `false` gives a bare scene with a little ambient light. */
  readonly stage?: StageOptions | false;
}

/** Roughly a standing person, for the camera rig's seed and a stageless bare scene. */
const DEFAULT_BODY: Body = {
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

function setCastShadow(root: THREE.Object3D, on: boolean): void {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) node.castShadow = on;
  });
}

interface Loaded {
  readonly vrm: VRM;
  readonly face: VrmFaceDriver;
  readonly clips: ClipPlayer;
  readonly pose: AdditivePose;
}

/**
 * `AvatarRenderer` over three.js and three-vrm: loads a VRM 1.0 (or 0.x, turned to face
 * the camera) and VRMA clips, and drives expressions, mouth, look-at and clips.
 *
 * Plain three.js rather than react-three-fiber, which Spike B used: the interface already
 * says who owns the loop (`update`, "driven by the render loop, not by a timer inside
 * the renderer"), and a renderer that is a class can be driven by the stage, a test page
 * or a recording harness without being a React tree.
 *
 * The rules shared with `FakeAvatarRenderer`: nothing but `mount` before a surface,
 * nothing that drives the character before one is loaded, and `dispose` is final.
 */
export class VrmAvatarRenderer implements AvatarRenderer<HTMLCanvasElement> {
  readonly id = 'vrm';

  private readonly deps: VrmRendererDeps;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(DEFAULT_FOV_DEGREES, 16 / 9, 0.1, 20);
  /** What `lookAt` follows; moved every frame, because the head moves under a clip. */
  private readonly gazeObject = new THREE.Object3D();
  private readonly animations = new Map<string, VRMAnimation>();

  private canvas: HTMLCanvasElement | null = null;
  private surface: DrawingSurface | null = null;
  private size: readonly [number, number] = [0, 0];
  private loaded: Loaded | null = null;
  private gaze: GazeTarget = 'user';
  private gazeOffset: GazeOffset = [0, 0];
  private readonly stage: THREE.Group | null;
  private readonly rig: CameraRig;
  private cameraPreset: CameraPreset = 'bust';
  private shadowsOn: boolean;
  private life: LifePose | null = null;
  private disposed = false;

  constructor(deps: Partial<VrmRendererDeps> = {}, options: VrmRendererOptions = {}) {
    this.deps = { ...defaultDeps(), ...deps };

    if (options.stage === false) {
      // No room: keep a little ambient light so a model is still visible.
      this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
      this.stage = null;
      this.shadowsOn = false;
    } else {
      const stageOptions = options.stage ?? DEFAULT_STAGE_OPTIONS;
      this.stage = buildStage(stageOptions);
      this.shadowsOn = stageOptions.shadows;
      this.scene.add(this.stage);
    }
    this.scene.add(this.gazeObject);
    this.rig = new CameraRig(framing(this.cameraPreset, DEFAULT_BODY, DEFAULT_FOV_DEGREES));
  }

  capabilities(): AvatarCapabilities {
    return { expressions: true, visemes: true, lookAt: true, clips: true, boneAccess: true };
  }

  mount(canvas: HTMLCanvasElement): Promise<void> {
    this.assertLive();
    this.surface?.dispose();
    this.canvas = canvas;
    this.surface = this.deps.createSurface(canvas);
    this.surface.setPixelRatio(this.deps.pixelRatio());
    this.size = [0, 0];
    return Promise.resolve();
  }

  async loadCharacter(source: CharacterSource): Promise<void> {
    this.assertLive();
    if (this.surface === null) throw new Error('mount before loadCharacter');
    const parsed = CharacterSourceSchema.parse(source);

    const gltf = await this.deps.loadGltf(parsed.url);
    const vrm = gltf.userData['vrm'] as VRM | undefined;
    if (vrm === undefined) throw new Error(`${parsed.url} is a glTF with no VRM extension`);
    if (this.disposed) {
      VRMUtils.deepDispose(vrm.scene);
      return;
    }
    VRMUtils.rotateVRM0(vrm);
    // A VRMA can animate the look-at, and it does so through this proxy; three-vrm-animation
    // makes one with a console warning if it is missing, so it is made here, once.
    if (vrm.lookAt !== null && vrm.lookAt !== undefined) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'lookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }

    this.unloadCharacter();
    this.scene.add(vrm.scene);
    setCastShadow(vrm.scene, this.shadowsOn);
    const face = new VrmFaceDriver(vrm);
    face.attachGazeTarget(this.gazeObject);
    const clips = new ClipPlayer(vrm.scene);
    for (const [id, animation] of this.animations) {
      clips.add(id, createVRMAnimationClip(animation, vrm));
    }
    const pose = new AdditivePose((bone: LifeBone) => vrm.humanoid.getNormalizedBoneNode(bone));
    this.loaded = { vrm, face, clips, pose };
    this.frameHead();
  }

  /**
   * Loads a VRMA and registers it under `id` for `playClip`. Not on the interface: which
   * clips exist is the clip library's business (P2-T03), not the caller's.
   *
   * Clips outlive a character — each is retargeted onto whichever model is loaded, now
   * and on every later `loadCharacter`.
   */
  async loadClip(id: string, url: string): Promise<void> {
    this.assertLive();
    const gltf = await this.deps.loadGltf(url);
    const animations = gltf.userData['vrmAnimations'] as VRMAnimation[] | undefined;
    const animation = animations?.[0];
    if (animation === undefined) throw new Error(`${url} contains no VRM animation`);
    this.animations.set(id, animation);
    if (this.loaded !== null) {
      this.loaded.clips.add(id, createVRMAnimationClip(animation, this.loaded.vrm));
    }
  }

  setExpression(weights: ExpressionWeights): void {
    this.character().face.setExpression(weights);
  }

  setViseme(viseme: Viseme, weight: number): void {
    this.character().face.setViseme(viseme, weight);
  }

  /** While a life pose is set it owns the gaze; steer it with `LifeLayer.setGazeBase`. */
  setGaze(target: GazeTarget): void {
    this.character();
    this.gaze = target;
    this.gazeOffset = [0, 0];
    this.placeGaze();
  }

  playClip(clipId: string, options: ClipOptions): Promise<void> {
    return this.character().clips.play(clipId, options);
  }

  update(deltaMs: number): void {
    if (this.disposed || this.surface === null) return;
    this.fitCanvas();
    // Steps the rig towards its goal and applies it, every frame — a transition in
    // progress, or a settled preset, either way the camera comes from here, not from
    // `frameHead`'s one-shot set.
    const pose = this.rig.update(deltaMs);
    this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    const loaded = this.loaded;
    if (loaded !== null) {
      // Take last frame's life off before the mixer writes this frame's clip pose.
      loaded.pose.restore();
      loaded.clips.update(deltaMs);
      this.applyLife(loaded);
      // After the camera, so gaze reads this frame's position, not last frame's.
      this.placeGaze();
      // After the mixer, so expressions, look-at, spring bones and constraints all
      // settle on this frame's pose (Spike B's order).
      loaded.vrm.update(deltaMs / 1000);
    }
    this.surface.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unloadCharacter();
    this.surface?.dispose();
    this.surface = null;
    this.canvas = null;
  }

  // --- beyond the interface, for the life layer and the debug panel ---

  /**
   * The life layer's pose for the next `update` (P2-T02), or null to stop applying one.
   * Additive over clips; the rest pose only while no clip is posing the body.
   */
  setLifePose(pose: LifePose | null): void {
    this.character();
    this.life = pose;
    if (pose === null) this.loaded?.face.setBlink(0);
  }

  /**
   * A humanoid bone by its VRM name, normalised so a rotation means the same thing on
   * every rig (`capabilities().boneAccess`, for P2-T02). Null with no character, or for
   * an optional bone this rig lacks.
   */
  bone(name: VRMHumanBoneName): THREE.Object3D | null {
    return this.loaded?.vrm.humanoid.getNormalizedBoneNode(name) ?? null;
  }

  /**
   * Moves the camera to a preset (P2-T05), eased over `transitionMs` (default 700, `0`
   * snaps) from wherever it currently is — a preset picked mid-transition never jumps.
   * Framed from the loaded model's own bones; with none loaded, from a generic body.
   */
  setCameraPreset(preset: CameraPreset, transitionMs = DEFAULT_TRANSITION_MS): void {
    this.assertLive();
    this.cameraPreset = preset;
    this.rig.setGoal(framing(preset, this.bodyHeights(), DEFAULT_FOV_DEGREES), transitionMs);
  }

  /**
   * Toggles PCF soft shadows: the surface's shadow map, the stage's `key` light (the only
   * caster) and the loaded character's meshes together, so nothing is left half-lit.
   */
  setShadows(on: boolean): void {
    this.shadowsOn = on;
    const shadowMap = this.surface?.shadowMap;
    if (shadowMap !== undefined) shadowMap.enabled = on;
    const key = this.stage?.getObjectByName('key');
    if (key instanceof THREE.DirectionalLight) key.castShadow = on;
    if (this.loaded !== null) setCastShadow(this.loaded.vrm.scene, on);
    // Materials are compiled with or without shadow sampling. Without a recompile, "off"
    // kept drawing the last shadow map — seen in the Browser pane (P2-T05 review).
    this.scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials: THREE.Material[] = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) material.needsUpdate = true;
    });
  }

  /**
   * The drawing buffer's pixel ratio, independent of the device's own — the debug panel's
   * 1080p render scale sets `1920 / canvas.clientWidth` so the buffer is 1920 px wide
   * whatever the column is.
   */
  setPixelRatio(ratio: number): void {
    this.surface?.setPixelRatio(ratio);
  }

  /** What each protocol expression resolved to on the loaded model. */
  expressionPlan(): ExpressionPlan | null {
    return this.loaded?.face.plan ?? null;
  }

  /** The loaded model's own expression names. */
  modelExpressions(): readonly string[] {
    return this.loaded?.face.available ?? [];
  }

  clipIds(): readonly string[] {
    return [...this.animations.keys()];
  }

  // --- internals ---

  private character(): Loaded {
    this.assertLive();
    if (this.loaded === null) throw new Error('no character loaded');
    return this.loaded;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('renderer is disposed');
  }

  private applyLife(loaded: Loaded): void {
    const life = this.life;
    if (life === null) return;
    loaded.pose.apply(loaded.clips.posing ? [life.additive] : [life.rest, life.additive], life.hipsOffset);
    loaded.face.setBlink(life.blink);
    this.gaze = life.gaze.target;
    this.gazeOffset = life.gaze.offset;
  }

  private unloadCharacter(): void {
    const loaded = this.loaded;
    if (loaded === null) return;
    this.loaded = null;
    this.life = null;
    loaded.pose.restore();
    loaded.clips.dispose();
    this.scene.remove(loaded.vrm.scene);
    VRMUtils.deepDispose(loaded.vrm.scene);
  }

  private headPosition(): Vec3 | null {
    const head = this.loaded?.vrm.humanoid.getNormalizedBoneNode('head');
    if (head === null || head === undefined) return null;
    const position = head.getWorldPosition(new THREE.Vector3());
    return [position.x, position.y, position.z];
  }

  /** Computes the body from the loaded model's bones and gives the rig a new, snapped goal. */
  private frameHead(): void {
    this.loaded?.vrm.scene.updateMatrixWorld(true);
    this.rig.setGoal(framing(this.cameraPreset, this.bodyHeights(), DEFAULT_FOV_DEGREES), 0);
    this.placeGaze();
  }

  /**
   * The loaded model's own proportions, for `framing` — bone heights plus where it
   * stands, read from the humanoid rig rather than hard-coded. Falls back to a generic
   * standing body with no character loaded.
   */
  private bodyHeights(): Body {
    const vrm = this.loaded?.vrm;
    if (vrm === undefined) return DEFAULT_BODY;
    const humanoid = vrm.humanoid;
    const boneY = (name: VRMHumanBoneName): number | null => {
      const node = humanoid.getNormalizedBoneNode(name);
      return node === null ? null : node.getWorldPosition(new THREE.Vector3()).y;
    };
    const [x, head, z] = this.headPosition() ?? [DEFAULT_BODY.x, DEFAULT_BODY.head, DEFAULT_BODY.z];
    // The crown, hair included: the head bone is at the base of the skull, and framing to
    // it cropped the top of her head (P2-T05 review).
    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    const eyes = [boneY('leftEye'), boneY('rightEye')].filter((y): y is number => y !== null);
    return {
      x,
      z,
      head,
      top: bounds.isEmpty() ? null : bounds.max.y,
      eyes: eyes.length === 0 ? null : eyes.reduce((sum, y) => sum + y, 0) / eyes.length,
      upperChest: boneY('upperChest'),
      chest: boneY('chest'),
      hips: boneY('hips'),
      leftFoot: boneY('leftFoot'),
      rightFoot: boneY('rightFoot'),
    };
  }

  private placeGaze(): void {
    const head = this.headPosition();
    if (head === null) return;
    const { x, y, z } = this.camera.position;
    const [px, py, pz] = gazePoint(this.gaze, head, [x, y, z], this.gazeOffset);
    this.gazeObject.position.set(px, py, pz);
    this.gazeObject.updateMatrixWorld();
  }

  /** Follows the canvas's CSS size, so a stage that resizes never draws stretched. */
  private fitCanvas(): void {
    const canvas = this.canvas;
    if (canvas === null || this.surface === null) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (width === this.size[0] && height === this.size[1]) return;
    this.size = [width, height];
    this.surface.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
