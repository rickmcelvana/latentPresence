/**
 * glTF animation → VRM Animation (`.vrma`), with no three.js and no Blender (P2-T03).
 *
 * A `.vrma` is a glTF whose `VRMC_vrm_animation` extension names which node is which
 * humanoid bone. `three-vrm-animation` then retargets it onto any VRM by dividing each
 * rotation by the file's own **rest pose** (`parentRestWorld · local · restWorld⁻¹`), so
 * the only thing a source skeleton must get right is that its rest pose is VRM's: a T-pose
 * facing +Z. Quaternius's Universal Animation Library already is — measured 2026-09-23,
 * arms level along ±X at 1.441 m, legs straight, toes towards +Z (`docs/SURFACE.md`) — so
 * converting is a matter of relabelling and filtering, not re-posing. A source that is not
 * in T-pose would need its rest re-posed first, and this module refuses nothing to warn of
 * that: {@link checkTPose} is the check, and the build tool runs it.
 *
 * **What is kept, and why it has to be exact.** The loader pairs `animation.channels[i]`
 * with the i-th track three's `GLTFLoader` built, and throws on a path it does not know.
 * The source animates translation, rotation *and scale* on all 65 bones; a `.vrma` may
 * carry a rotation for each humanoid bone and a translation for `hips` only. So every other
 * channel is dropped, and the node tree is kept whole (without mesh or skin) because the
 * loader reads rest poses from world matrices — the `root` and `Armature` parents included.
 */

/** A humanoid bone name as VRM 1.0 spells it. */
export type VrmHumanBone = string;

/**
 * UAL's Unreal-style names → VRM 1.0 humanoid bones. `root` stays unmapped: it is the
 * skeleton's parent, not a body part. The `_04_leaf` finger ends and `ball_leaf` have no
 * VRM counterpart and carry no motion worth keeping.
 */
export const UAL_TO_VRM: Readonly<Record<string, VrmHumanBone>> = (() => {
  const map: Record<string, VrmHumanBone> = {
    pelvis: 'hips',
    spine_01: 'spine',
    spine_02: 'chest',
    spine_03: 'upperChest',
    neck_01: 'neck',
    Head: 'head',
  };
  const fingers = [
    ['thumb', 'Thumb', ['Metacarpal', 'Proximal', 'Distal']],
    ['index', 'Index', ['Proximal', 'Intermediate', 'Distal']],
    ['middle', 'Middle', ['Proximal', 'Intermediate', 'Distal']],
    ['ring', 'Ring', ['Proximal', 'Intermediate', 'Distal']],
    ['pinky', 'Little', ['Proximal', 'Intermediate', 'Distal']],
  ] as const;
  for (const [suffix, side] of [
    ['l', 'left'],
    ['r', 'right'],
  ] as const) {
    map[`clavicle_${suffix}`] = `${side}Shoulder`;
    map[`upperarm_${suffix}`] = `${side}UpperArm`;
    map[`lowerarm_${suffix}`] = `${side}LowerArm`;
    map[`hand_${suffix}`] = `${side}Hand`;
    map[`thigh_${suffix}`] = `${side}UpperLeg`;
    map[`calf_${suffix}`] = `${side}LowerLeg`;
    map[`foot_${suffix}`] = `${side}Foot`;
    map[`ball_${suffix}`] = `${side}Toes`;
    for (const [ual, vrm, joints] of fingers) {
      joints.forEach((joint, index) => {
        map[`${ual}_0${index + 1}_${suffix}`] = `${side}${vrm}${joint}`;
      });
    }
  }
  return map;
})();

interface GltfNode {
  name?: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
  mesh?: number;
  skin?: number;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfChannel {
  sampler: number;
  target: { node?: number; path: string };
}

interface GltfSampler {
  input: number;
  output: number;
  interpolation?: string;
}

interface GltfAnimation {
  name?: string;
  channels: GltfChannel[];
  samplers: GltfSampler[];
}

interface Gltf {
  asset: { version: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { byteLength: number }[];
  animations?: GltfAnimation[];
}

export interface Glb {
  readonly json: Gltf;
  readonly bin: Uint8Array;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC3: 3, VEC4: 4 };

export function parseGlb(bytes: Uint8Array): Glb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB file');
  let offset = 12;
  let json: Gltf | null = null;
  let bin: Uint8Array = new Uint8Array(0);
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
    if (type === CHUNK_BIN) bin = chunk;
    offset += 8 + length;
  }
  if (json === null) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

export function writeGlb(json: object, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(text.byteLength);
  const binLength = align4(bin.byteLength);
  const total = 12 + 8 + jsonLength + (binLength > 0 ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  // JSON is padded with spaces, the binary chunk with zeros (glTF 2.0 §4.4.3).
  out.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
  if (binLength > 0) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}

function align4(n: number): number {
  return Math.ceil(n / 4) * 4;
}

/** An accessor's floats, read tightly packed whatever the source's stride. */
function readFloats(gltf: Glb, index: number): { values: Float32Array; accessor: GltfAccessor } {
  const accessor = gltf.json.accessors?.[index];
  if (accessor === undefined) throw new Error(`accessor ${index} does not exist`);
  if (accessor.componentType !== FLOAT) throw new Error(`accessor ${index} is not float (${accessor.componentType})`);
  if (accessor.sparse !== undefined || accessor.bufferView === undefined) throw new Error(`accessor ${index} is sparse or empty`);
  const width = COMPONENTS[accessor.type];
  if (width === undefined) throw new Error(`accessor ${index} has type ${accessor.type}`);
  const bufferView = gltf.json.bufferViews?.[accessor.bufferView];
  if (bufferView === undefined) throw new Error(`bufferView ${accessor.bufferView} does not exist`);
  const stride = bufferView.byteStride ?? width * 4;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(gltf.bin.buffer, gltf.bin.byteOffset, gltf.bin.byteLength);
  const values = new Float32Array(accessor.count * width);
  for (let i = 0; i < accessor.count; i += 1) {
    for (let c = 0; c < width; c += 1) values[i * width + c] = view.getFloat32(start + i * stride + c * 4, true);
  }
  return { values, accessor };
}

export interface VrmaOptions {
  /** Source node name → VRM humanoid bone. */
  readonly boneMap: Readonly<Record<string, VrmHumanBone>>;
  /** Written into `asset.generator`, so a file says where it came from. */
  readonly generator: string;
}

/**
 * One animation of `source`, as a `.vrma`. Deterministic: the same input gives the same
 * bytes, so a rebuilt clip that did not change shows no diff.
 */
export function buildVrma(source: Glb, animationName: string, options: VrmaOptions): Uint8Array {
  const { json } = source;
  const animation = json.animations?.find((candidate) => candidate.name === animationName);
  if (animation === undefined) throw new Error(`no animation named "${animationName}"`);
  const nodes = json.nodes ?? [];

  const humanBones: Record<VrmHumanBone, { node: number }> = {};
  nodes.forEach((node, index) => {
    const bone = node.name === undefined ? undefined : options.boneMap[node.name];
    if (bone !== undefined) humanBones[bone] = { node: index };
  });
  const hips = humanBones['hips'];
  if (hips === undefined) throw new Error('the bone map names no hips');

  const outNodes = nodes.map((node) => {
    // The mesh and skin are what make the source 7 MB; a clip needs only the tree.
    const { mesh: _mesh, skin: _skin, ...rest } = node;
    return rest;
  });

  const chunks: Float32Array[] = [];
  const accessors: GltfAccessor[] = [];
  const bufferViews: GltfBufferView[] = [];
  let byteLength = 0;
  const copied = new Map<number, number>();
  function copy(index: number): number {
    const existing = copied.get(index);
    if (existing !== undefined) return existing;
    const { values, accessor } = readFloats(source, index);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: values.byteLength });
    const out: GltfAccessor = { bufferView: bufferViews.length - 1, componentType: FLOAT, count: accessor.count, type: accessor.type };
    // Min and max are required on an animation input (glTF 2.0 §5.1.7).
    if (accessor.min !== undefined) out.min = accessor.min;
    if (accessor.max !== undefined) out.max = accessor.max;
    accessors.push(out);
    chunks.push(values);
    byteLength += values.byteLength;
    copied.set(index, accessors.length - 1);
    return accessors.length - 1;
  }

  const humanNodes = new Set(Object.values(humanBones).map((bone) => bone.node));
  const channels: GltfChannel[] = [];
  const samplers: GltfSampler[] = [];
  for (const channel of animation.channels) {
    const node = channel.target.node;
    if (node === undefined || !humanNodes.has(node)) continue;
    const { path } = channel.target;
    if (path !== 'rotation' && !(path === 'translation' && node === hips.node)) continue;
    const sampler = animation.samplers[channel.sampler];
    if (sampler === undefined) throw new Error(`channel refers to missing sampler ${channel.sampler}`);
    samplers.push({ input: copy(sampler.input), output: copy(sampler.output), interpolation: sampler.interpolation ?? 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node, path } });
  }

  const bin = new Uint8Array(byteLength);
  let at = 0;
  for (const chunk of chunks) {
    bin.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), at);
    at += chunk.byteLength;
  }

  const out = {
    asset: { version: '2.0', generator: options.generator },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones } } },
    scene: 0,
    scenes: json.scenes ?? [{ nodes: [0] }],
    nodes: outNodes,
    buffers: [{ byteLength }],
    bufferViews,
    accessors,
    animations: [{ name: animationName, channels, samplers }],
  };
  return writeGlb(out, bin);
}

/** A node's rest position in world space, from the tree's own translations and rotations. */
export function restWorldPositions(json: Gltf): Map<string, [number, number, number]> {
  const nodes = json.nodes ?? [];
  const result = new Map<string, [number, number, number]>();
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const visit = (index: number, parentPosition: [number, number, number], parentRotation: Quat): void => {
    const node = nodes[index];
    if (node === undefined) return;
    if (node.matrix !== undefined) throw new Error(`node ${node.name ?? index} uses a matrix; not supported`);
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const local = rotate(parentRotation, [tx ?? 0, ty ?? 0, tz ?? 0]);
    const position: [number, number, number] = [parentPosition[0] + local[0], parentPosition[1] + local[1], parentPosition[2] + local[2]];
    const rotation = multiply(parentRotation, (node.rotation ?? [0, 0, 0, 1]) as Quat);
    if (node.name !== undefined) result.set(node.name, position);
    for (const child of node.children ?? []) visit(child, position, rotation);
  };
  for (const root of roots) visit(root, [0, 0, 0], [0, 0, 0, 1]);
  return result;
}

type Quat = readonly [number, number, number, number] | number[];

function multiply(a: Quat, b: Quat): [number, number, number, number] {
  const [ax = 0, ay = 0, az = 0, aw = 1] = a;
  const [bx = 0, by = 0, bz = 0, bw = 1] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotate(q: Quat, v: readonly [number, number, number]): [number, number, number] {
  const [x = 0, y = 0, z = 0, w = 1] = q;
  const [r0 = 0, r1 = 0, r2 = 0] = multiply(multiply([x, y, z, w], [v[0], v[1], v[2], 0]), [-x, -y, -z, w]);
  return [r0, r1, r2];
}

/** How far a bone points off the horizontal, in degrees. */
function armDrop(from: readonly number[], to: readonly number[]): number {
  const [fx = 0, fy = 0, fz = 0] = from;
  const [tx = 0, ty = 0, tz = 0] = to;
  return Math.abs(Math.atan2(ty - fy, Math.hypot(tx - fx, tz - fz)) * (180 / Math.PI));
}

/**
 * Whether a skeleton's rest pose is VRM's T-pose facing +Z, which is the one thing
 * `three-vrm-animation`'s retarget assumes of a `.vrma`. Returns the problems found, empty
 * when there are none. Tolerances are loose on purpose: this catches an A-pose (arms ~45°
 * down) or a character facing −Z, not a degree of drift.
 */
export function checkTPose(json: Gltf, boneMap: Readonly<Record<string, VrmHumanBone>>): string[] {
  const positions = restWorldPositions(json);
  const byBone = new Map<VrmHumanBone, [number, number, number]>();
  for (const [name, position] of positions) {
    const bone = boneMap[name];
    if (bone !== undefined) byBone.set(bone, position);
  }
  const problems: string[] = [];
  const need = (bone: VrmHumanBone): [number, number, number] | null => {
    const position = byBone.get(bone);
    if (position === undefined) problems.push(`no ${bone}`);
    return position ?? null;
  };
  const leftArm = need('leftUpperArm');
  const leftHand = need('leftHand');
  const rightArm = need('rightUpperArm');
  const rightHand = need('rightHand');
  const leftFoot = need('leftFoot');
  const leftToes = need('leftToes');
  const hips = need('hips');
  const head = need('head');
  if (problems.length > 0) return problems;
  if (leftArm === null || leftHand === null || rightArm === null || rightHand === null) return problems;
  if (leftFoot === null || leftToes === null || hips === null || head === null) return problems;

  if (leftHand[0] <= leftArm[0]) problems.push('the left hand is not towards +X: not a VRM T-pose, or facing −Z');
  if (rightHand[0] >= rightArm[0]) problems.push('the right hand is not towards −X');
  if (armDrop(leftArm, leftHand) > 10) problems.push(`the left arm is ${armDrop(leftArm, leftHand).toFixed(0)}° off level (an A-pose?)`);
  if (armDrop(rightArm, rightHand) > 10) problems.push(`the right arm is ${armDrop(rightArm, rightHand).toFixed(0)}° off level (an A-pose?)`);
  if (leftToes[2] <= leftFoot[2]) problems.push('the toes do not point towards +Z: the character is not facing +Z');
  if (head[1] <= hips[1]) problems.push('the head is not above the hips');
  return problems;
}
