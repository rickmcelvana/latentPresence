import * as THREE from 'three';

/**
 * What one frame of the stage costs to draw, in the units that do not depend on the GPU
 * drawing it (P9-T02, ADR-68): CI renders with a software rasteriser, where a frame time
 * means nothing, but a draw call, a triangle and a texture cost the same everywhere.
 */
export interface FrameStats {
  /** Draw calls in the last frame, the shadow pass included. */
  readonly drawCalls: number;
  readonly triangles: number;
  /** Geometries and textures the renderer holds on the GPU. */
  readonly geometries: number;
  readonly textures: number;
  /** Shader programs compiled. */
  readonly programs: number;
  /** The drawing buffer, in device pixels. */
  readonly pixels: number;
  /** `sceneTextureBytes` of the scene: an estimate of the GPU memory its textures take. */
  readonly textureBytes: number;
}

/** What `THREE.WebGLRenderer.info` carries that `FrameStats` reads. */
export interface RendererInfo {
  readonly render: { readonly calls: number; readonly triangles: number };
  readonly memory: { readonly geometries: number; readonly textures: number };
  readonly programs: readonly unknown[] | null;
}

function imageSize(image: unknown): readonly [number, number] | null {
  if (typeof image !== 'object' || image === null) return null;
  const { width, height } = image as { width?: unknown; height?: unknown };
  return typeof width === 'number' && typeof height === 'number' ? [width, height] : null;
}

/**
 * The bytes the textures of every mesh under `root` take once uploaded: four a texel, and a
 * third more where mipmaps are generated. Each image is counted once, however many materials
 * share it. An estimate — a compressed texture would be smaller — and the stage has none.
 */
export function sceneTextureBytes(root: THREE.Object3D): number {
  const seen = new Set<unknown>();
  let bytes = 0;
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials: unknown[] = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (typeof material !== 'object' || material === null) continue;
      for (const value of Object.values(material)) {
        if (!(value instanceof THREE.Texture) || seen.has(value.source)) continue;
        seen.add(value.source);
        const size = imageSize(value.image);
        if (size === null) continue;
        const texels = size[0] * size[1];
        bytes += texels * 4 * (value.generateMipmaps ? 4 / 3 : 1);
      }
    }
  });
  return Math.round(bytes);
}

export function frameStats(info: RendererInfo, pixels: number, root: THREE.Object3D): FrameStats {
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length ?? 0,
    pixels,
    textureBytes: sceneTextureBytes(root),
  };
}
