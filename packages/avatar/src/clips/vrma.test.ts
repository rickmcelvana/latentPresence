/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, type VRMAnimation } from '@pixiv/three-vrm-animation';
import { UAL_TO_VRM, buildVrma, checkTPose, parseGlb, writeGlb } from './vrma';

/**
 * A three-bone skeleton in the UAL shape — `Armature` → `root` (turned −90° about X, as the
 * pack's is) → `pelvis` → `upperarm_l`/`hand_l` … — built as a GLB in memory, with an
 * animation that moves every path on every bone, the way the pack does.
 */
// Under a −90° X root, glTF's +Y is the source's +Z: positions are given in world terms
// and rotated into root space (x, y, z) → (x, −z, y).
function local(x: number, y: number, z: number): number[] {
  return [x, -z, y];
}

function tinySource(options: { armDrop?: number; faceMinusZ?: boolean } = {}): Uint8Array {
  const drop = options.armDrop ?? 0;
  const flip = options.faceMinusZ === true ? -1 : 1;
  const nodes = [
    { name: 'Armature', children: [1] },
    { name: 'root', rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: [2] },
    { name: 'pelvis', translation: local(0, 0.9, 0), children: [3, 5, 7, 9, 10, 11] },
    { name: 'upperarm_l', translation: local(0.2 * flip, 0.5, 0), children: [4] },
    { name: 'hand_l', translation: local(0.5 * flip, -drop, 0) },
    { name: 'upperarm_r', translation: local(-0.2 * flip, 0.5, 0), children: [6] },
    { name: 'hand_r', translation: local(-0.5 * flip, -drop, 0) },
    { name: 'foot_l', translation: local(0.1, -0.8, 0), children: [8] },
    { name: 'ball_l', translation: local(0, -0.05, 0.12 * flip) },
    { name: 'Head', translation: local(0, 0.65, 0) },
    { name: 'thumb_04_leaf_l', translation: local(0.1, 0, 0) },
    { name: 'Mannequin', mesh: 0 },
  ];
  const times = new Float32Array([0, 1]);
  const quat = new Float32Array([0, 0, 0, 1, 0, 0.0998, 0, 0.995]);
  const vec = new Float32Array([0, 0, 0, 0, 0.01, 0]);
  const bin = new Uint8Array(times.byteLength + quat.byteLength + vec.byteLength);
  bin.set(new Uint8Array(times.buffer), 0);
  bin.set(new Uint8Array(quat.buffer), times.byteLength);
  bin.set(new Uint8Array(vec.buffer), times.byteLength + quat.byteLength);
  const channels: object[] = [];
  const samplers = [
    { input: 0, output: 1 },
    { input: 0, output: 2 },
    { input: 0, output: 2 },
  ];
  for (const node of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    channels.push({ sampler: 0, target: { node, path: 'rotation' } });
    channels.push({ sampler: 1, target: { node, path: 'translation' } });
    channels.push({ sampler: 2, target: { node, path: 'scale' } });
  }
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{ primitives: [] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: times.byteLength },
      { buffer: 0, byteOffset: times.byteLength, byteLength: quat.byteLength },
      { buffer: 0, byteOffset: times.byteLength + quat.byteLength, byteLength: vec.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    animations: [
      { name: 'Other', channels: [], samplers: [] },
      { name: 'Idle_Loop', channels, samplers },
    ],
  };
  return writeGlb(json, bin);
}

async function loadVrma(bytes: Uint8Array): Promise<VRMAnimation> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await loader.parseAsync(buffer, '');
  const animation = (gltf.userData['vrmAnimations'] as VRMAnimation[] | undefined)?.[0];
  if (animation === undefined) throw new Error('no VRM animation in the file');
  return animation;
}

describe('buildVrma', () => {
  it('keeps a rotation per humanoid bone and a translation on hips only, and drops scale', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const animation = await loadVrma(buildVrma(parseGlb(tinySource()), 'Idle_Loop', { boneMap: UAL_TO_VRM, generator: 'test' }));

    expect([...animation.humanoidTracks.rotation.keys()].toSorted()).toEqual(
      ['head', 'hips', 'leftFoot', 'leftHand', 'leftToes', 'leftUpperArm', 'rightHand', 'rightUpperArm'].toSorted(),
    );
    expect([...animation.humanoidTracks.translation.keys()]).toEqual(['hips']);
    // Any track the loader objected to — a translation on an arm, an unknown path — is a
    // console warning or an exception; neither may happen.
    expect(warn).not.toHaveBeenCalled();
    expect(animation.duration).toBe(1);
    expect(animation.restHipsPosition.y).toBeCloseTo(0.9);
    warn.mockRestore();
  });

  it('drops the mesh and keeps the whole node tree, since rest poses are read through it', () => {
    const out = parseGlb(buildVrma(parseGlb(tinySource()), 'Idle_Loop', { boneMap: UAL_TO_VRM, generator: 'test' }));
    expect(out.json.nodes?.map((node) => node.name)).toContain('root');
    expect(out.json.nodes?.some((node) => 'mesh' in node)).toBe(false);
  });

  it('is deterministic, so an unchanged rebuild shows no diff', () => {
    const source = parseGlb(tinySource());
    const a = buildVrma(source, 'Idle_Loop', { boneMap: UAL_TO_VRM, generator: 'test' });
    const b = buildVrma(source, 'Idle_Loop', { boneMap: UAL_TO_VRM, generator: 'test' });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('refuses an animation that is not there', () => {
    expect(() => buildVrma(parseGlb(tinySource()), 'Wave', { boneMap: UAL_TO_VRM, generator: 'test' })).toThrow(/Wave/u);
  });
});

describe('checkTPose', () => {
  it('passes the UAL shape: arms level along ±X, toes towards +Z', () => {
    expect(checkTPose(parseGlb(tinySource()).json, UAL_TO_VRM)).toEqual([]);
  });

  it('catches an A-pose', () => {
    const problems = checkTPose(parseGlb(tinySource({ armDrop: 0.4 })).json, UAL_TO_VRM);
    expect(problems.some((problem) => problem.includes('A-pose'))).toBe(true);
  });

  it('catches a character facing −Z', () => {
    expect(checkTPose(parseGlb(tinySource({ faceMinusZ: true })).json, UAL_TO_VRM).length).toBeGreaterThan(0);
  });
});

describe('the committed clips', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../assets/clips/manifest.json', import.meta.url)), 'utf8')) as {
    clips: { id: string; file: string; bytes: number; licence: string }[];
  };

  it('are CC0, listed with their sizes, and load as VRM animations with every body bone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(manifest.clips.map((clip) => clip.id)).toEqual(['idle', 'talk']);
    for (const clip of manifest.clips) {
      expect(clip.licence).toBe('CC0-1.0');
      const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../assets/clips/${clip.file}`, import.meta.url))));
      expect(bytes.byteLength).toBe(clip.bytes);
      const animation = await loadVrma(bytes);
      const bones = [...animation.humanoidTracks.rotation.keys()];
      for (const bone of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightHand', 'leftUpperLeg', 'rightFoot', 'leftIndexDistal']) {
        expect(bones).toContain(bone);
      }
      expect(animation.duration).toBeGreaterThan(2);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
