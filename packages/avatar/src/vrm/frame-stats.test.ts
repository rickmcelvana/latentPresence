import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { frameStats, sceneTextureBytes } from './frame-stats';
import { VrmAvatarRenderer, type DrawingSurface } from './renderer';

function texture(width: number, height: number, mipmaps = true): THREE.Texture {
  const made = new THREE.Texture({ width, height });
  made.generateMipmaps = mipmaps;
  return made;
}

describe('sceneTextureBytes (P9-T02)', () => {
  it('counts four bytes a texel, a third more with mipmaps, and a shared image once', () => {
    const shared = texture(256, 256);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: shared, normalMap: texture(128, 64, false) })));
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial({ map: shared }), new THREE.MeshBasicMaterial()]));
    expect(sceneTextureBytes(root)).toBe(Math.round(256 * 256 * 4 * (4 / 3)) + 128 * 64 * 4);
  });

  it('is zero for a scene with no textures, or one whose image is not loaded yet', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.Texture() })));
    expect(sceneTextureBytes(root)).toBe(0);
  });
});

describe('frameStats', () => {
  it('reads the renderer info and the drawing buffer', () => {
    const info = { render: { calls: 40, triangles: 70_000 }, memory: { geometries: 30, textures: 12 }, programs: [{}, {}, {}] };
    expect(frameStats(info, 1920 * 1080, new THREE.Group())).toEqual({
      drawCalls: 40,
      triangles: 70_000,
      geometries: 30,
      textures: 12,
      programs: 3,
      pixels: 1920 * 1080,
      textureBytes: 0,
    });
  });

  it('comes from VrmAvatarRenderer once mounted on a surface that counts, and is null on one that does not', async () => {
    const counting: DrawingSurface = {
      setPixelRatio: () => undefined,
      setSize: () => undefined,
      render: () => undefined,
      dispose: () => undefined,
      info: { render: { calls: 5, triangles: 900 }, memory: { geometries: 4, textures: 1 }, programs: null },
      getDrawingBufferSize: (target) => target.set(640, 360),
    };
    const renderer = new VrmAvatarRenderer({ createSurface: () => counting, pixelRatio: () => 1, loadGltf: () => Promise.reject(new Error('unused')) }, { stage: false });
    expect(renderer.frameStats()).toBeNull();
    await renderer.mount({} as HTMLCanvasElement);
    expect(renderer.frameStats()).toMatchObject({ drawCalls: 5, triangles: 900, programs: 0, pixels: 640 * 360 });

    const { info: _info, ...uncounted } = counting;
    const silent = new VrmAvatarRenderer(
      { createSurface: () => uncounted, pixelRatio: () => 1, loadGltf: () => Promise.reject(new Error('unused')) },
      { stage: false },
    );
    await silent.mount({} as HTMLCanvasElement);
    expect(silent.frameStats()).toBeNull();
  });
});
