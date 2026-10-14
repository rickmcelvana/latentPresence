import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { BodyRejectedError, CALL_PRESETS, REQUIRED_BONES, checkBody, type CheckedVrm } from './body-check';
import { VrmAvatarRenderer, type DrawingSurface } from './renderer';

/** A VRM-shaped object: every bone but `without`, the expressions named, a VRM 1.0 meta. */
function fakeVrm(options: { without?: readonly string[]; expressions?: readonly string[]; name?: string } = {}) {
  const scene = new THREE.Group();
  const bones = new Map<string, THREE.Object3D>();
  for (const bone of REQUIRED_BONES) {
    if (options.without?.includes(bone) === true) continue;
    const node = new THREE.Object3D();
    node.position.y = bone === 'head' ? 1.5 : 1;
    scene.add(node);
    bones.set(bone, node);
  }
  const expressionMap = Object.fromEntries((options.expressions ?? CALL_PRESETS).map((name) => [name, {}]));
  return {
    scene,
    humanoid: {
      getRawBoneNode: (name: string) => bones.get(name) ?? null,
      getNormalizedBoneNode: (name: string) => bones.get(name) ?? null,
    },
    expressionManager: { expressionMap, setValue: () => undefined },
    lookAt: null,
    meta: { metaVersion: '1', name: options.name ?? 'Test body', authors: ['Someone'], licenseUrl: 'https://vrm.dev/licenses/1.0/' },
    update: () => undefined,
  };
}

describe('checkBody (P7-T02, ADR-59)', () => {
  it('passes a whole body and says what it is', () => {
    expect(checkBody(fakeVrm() as CheckedVrm)).toEqual({
      name: 'Test body',
      authors: ['Someone'],
      licence: 'https://vrm.dev/licenses/1.0/',
      missing: [],
      lookAt: false,
    });
  });

  it('refuses a body without the bones every VRM needs, naming them', () => {
    expect(() => checkBody(fakeVrm({ without: ['leftHand', 'head'] }) as CheckedVrm)).toThrow(BodyRejectedError);
    expect(() => checkBody(fakeVrm({ without: ['leftHand', 'head'] }) as CheckedVrm)).toThrow(/head, leftHand/);
    expect(() => checkBody({ humanoid: null })).toThrow(/no humanoid rig/);
  });

  it('loads a body without some expressions, and lists them whatever their case', () => {
    const report = checkBody(fakeVrm({ expressions: ['Blink', 'A', 'happy'] }) as CheckedVrm);
    expect(report.missing).toEqual(['aa', 'ih', 'ou', 'ee', 'oh', 'angry', 'sad', 'relaxed', 'surprised']);
  });

  it("reads a VRM 0.x model's meta", () => {
    const report = checkBody({ ...fakeVrm(), meta: { metaVersion: '0', title: ' Old ', author: 'Maker', licenseName: 'CC_BY' } } as CheckedVrm);
    expect(report).toMatchObject({ name: 'Old', authors: ['Maker'], licence: 'CC_BY' });
  });
});

function surface(): DrawingSurface {
  return { setPixelRatio: () => undefined, setSize: () => undefined, render: () => undefined, dispose: () => undefined };
}

/** A renderer whose `loadGltf` hands back what each URL is mapped to, when the test says so. */
function rendererWith(files: Record<string, () => Promise<ReturnType<typeof fakeVrm>>>) {
  const renderer = new VrmAvatarRenderer(
    {
      createSurface: surface,
      pixelRatio: () => 1,
      loadGltf: async (url) => {
        const make = files[url];
        if (make === undefined) throw new Error('not a glTF');
        return { userData: { vrm: await make() }, scene: new THREE.Group() } as unknown as GLTF;
      },
    },
    { stage: false },
  );
  return renderer;
}

const source = (url: string) => ({ id: url, url, format: 'vrm' as const, licence: 'test', attribution: 'test' });

describe('VrmAvatarRenderer — swapping bodies (P7-T02)', () => {
  it('keeps the body on stage when the next one is refused', async () => {
    const renderer = rendererWith({ 'good.vrm': async () => fakeVrm({ name: 'Good' }), 'armless.vrm': async () => fakeVrm({ without: ['leftHand'] }) });
    await renderer.mount({} as HTMLCanvasElement);
    await renderer.loadCharacter(source('good.vrm'));

    await expect(renderer.loadCharacter(source('armless.vrm'))).rejects.toThrow(/leftHand/);
    await expect(renderer.loadCharacter(source('nothing.glb'))).rejects.toThrow(/cannot be read as a VRM/);
    expect(renderer.bodyReport()?.name).toBe('Good');
    renderer.setExpression({ happy: 1 });
  });

  it('drops a slow load that a later one overtook', async () => {
    let finishSlow: (() => void) | null = null;
    const renderer = rendererWith({
      'slow.vrm': () => new Promise((resolve) => (finishSlow = () => resolve(fakeVrm({ name: 'Slow' })))),
      'quick.vrm': async () => fakeVrm({ name: 'Quick' }),
    });
    await renderer.mount({} as HTMLCanvasElement);

    const slow = renderer.loadCharacter(source('slow.vrm'));
    await renderer.loadCharacter(source('quick.vrm'));
    (finishSlow as (() => void) | null)?.();
    await slow;

    expect(renderer.bodyReport()?.name).toBe('Quick');
  });
});
