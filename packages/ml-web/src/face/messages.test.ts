import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { FACE_MODEL, FACE_MODEL_URL, allowedRequest, faceModels, readFrame, type LandmarkerLike } from './messages';

const ORIGIN = 'https://app.latentpresence.com';

function frame(): ImageBitmap & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(), width: 640, height: 480 } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

describe('the face catalog (P3-T06)', () => {
  it('pins the model to version 1 and says its size, licence and source on the consent line', () => {
    expect(FACE_MODEL_URL).toContain('/float16/1/');
    expect(FACE_MODEL_URL).not.toContain('latest');
    expect(faceModels()).toEqual([FACE_MODEL]);
    expect(FACE_MODEL.sizeBytes).toBe(3_758_596);
    expect(FACE_MODEL.licence).toBe('Apache-2.0');
  });
});

describe('allowedRequest — what the face worker may fetch', () => {
  it('lets through its own origin and the one model file', () => {
    expect(allowedRequest(`${ORIGIN}/assets/vision_wasm_module_internal.wasm`, ORIGIN)).toBe(true);
    expect(allowedRequest('/node_modules/.pnpm/x/vision_wasm_module_internal.js', ORIGIN)).toBe(true);
    expect(allowedRequest(FACE_MODEL_URL, ORIGIN)).toBe(true);
  });

  it("refuses MediaPipe 1.x's metrics endpoint and anything else off-origin", () => {
    expect(allowedRequest('https://odml.pa.googleapis.com/v1/log', ORIGIN)).toBe(false);
    expect(allowedRequest('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task', ORIGIN)).toBe(false);
    expect(allowedRequest('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', ORIGIN)).toBe(false);
  });
});

describe('readFrame — no frame outlives its reading', () => {
  const categories = [
    { categoryName: 'mouthSmileLeft', score: 0.8 },
    { categoryName: 'mouthSmileRight', score: 0.7 },
  ];

  it('returns the blendshapes by name and closes the frame', () => {
    const bitmap = frame();
    const landmarker: LandmarkerLike = { detectForVideo: () => ({ faceBlendshapes: [{ categories }] }) };
    expect(readFrame(landmarker, bitmap, 1)).toEqual({ mouthSmileLeft: 0.8, mouthSmileRight: 0.7 });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('returns null with no face, and still closes the frame', () => {
    const bitmap = frame();
    expect(readFrame({ detectForVideo: () => ({ faceBlendshapes: [] }) }, bitmap, 1)).toBeNull();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('closes the frame when the landmarker throws', () => {
    const bitmap = frame();
    const landmarker: LandmarkerLike = {
      detectForVideo: () => {
        throw new Error('timestamps must increase');
      },
    };
    expect(() => readFrame(landmarker, bitmap, 1)).toThrow('timestamps must increase');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});

/**
 * The pin's tripwire (ADR-34). MediaPipe Tasks Vision 1.0.0 added a metrics logger that is on
 * by default; 0.10.35 has none. If a dependency bump brings it in, this fails before the
 * worker's request guard is the only thing standing between a user and Google's endpoint.
 */
describe('@mediapipe/tasks-vision as installed', () => {
  it('is the pinned 0.10.35 and carries no metrics logger', () => {
    const require = createRequire(import.meta.url);
    const bundle = require.resolve('@mediapipe/tasks-vision');
    const manifest = JSON.parse(readFileSync(bundle.replace(/vision_bundle\.[cm]?js$/u, 'package.json'), 'utf8')) as { version: string };
    expect(manifest.version).toBe('0.10.35');
    const source = readFileSync(bundle, 'utf8');
    expect(source).not.toContain('odml.pa.googleapis.com');
    expect(source).not.toContain('_mediapipeLoggerGetEncodedApiKey');
  });
});
