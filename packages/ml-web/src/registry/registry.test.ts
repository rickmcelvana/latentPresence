import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASR_MODELS, asrModel } from '../asr/messages';
import { FACE_MODEL, FACE_MODEL_URL } from '../face/messages';
import { kokoroModel } from '../kokoro/messages';
import { kokoroVoices } from '../kokoro/voices';
import { SER_MODELS } from '../ser/messages';
import { SILERO_VAD, SMART_TURN, modelUrl } from '../turn/messages';
import { REGISTRY, registryFiles } from './catalog';
import { KOKORO_MODEL_REPO, KOKORO_VOICES_REPO, PINS, asrFiles, pinnedBytes, pinnedFile, pinnedUrl } from './index';

describe('the pins', () => {
  it('names a whole commit, or for the one host without commits, a version in the path', () => {
    for (const [key, pin] of Object.entries(PINS)) {
      if (key === 'mediapipe/face_landmarker') expect(pin.base).toContain('/float16/1/');
      else expect(pin.revision, key).toMatch(/^[0-9a-f]{40}$/u);
      expect(pin.base, key).toContain(pin.revision);
    }
  });

  it('never points at a branch', () => {
    for (const pin of Object.values(PINS)) expect(pin.base).not.toMatch(/\/(main|master|dev|latest)\//u);
  });

  it('gives every file a size and a full SHA-256', () => {
    for (const [key, pin] of Object.entries(PINS)) {
      for (const [path, file] of Object.entries(pin.files)) {
        expect(file.sha256, `${key}/${path}`).toMatch(/^[0-9a-f]{64}$/u);
        expect(file.bytes, `${key}/${path}`).toBeGreaterThan(0);
      }
    }
  });

  it('throws on a file nobody pinned, rather than downloading it unchecked', () => {
    expect(() => pinnedFile('onnx-community/silero-vad', 'onnx/model_q4.onnx')).toThrow(/no pin/u);
    expect(() => pinnedUrl('nobody/nothing', 'x')).toThrow(/no pin/u);
  });
});

describe('what the consent screens quote', () => {
  it('is what was measured before the pins existed, so no one is shown a new number', () => {
    // Downloaded into an empty cache on 2026-09-13, and listed from the Hub (`docs/SURFACE.md`).
    expect(asrModel('moonshine-tiny', 'q8').sizeBytes).toBe(32_079_632);
    expect(asrModel('whisper-base', 'fp32').sizeBytes).toBe(82_451_730 + 208_686_733 + 2_769_562);
    expect(SILERO_VAD.bytes).toBe(2_243_022);
    expect(SMART_TURN.gpu.bytes).toBe(32_411_198);
    expect(FACE_MODEL.sizeBytes).toBe(3_758_596);
    expect(SER_MODELS.distill.files[0]?.bytes).toBe(9_695_687);
  });

  it('counts Kokoro as the graph and its config, which is what its load fetches', () => {
    expect(kokoroModel('q8').sizeBytes).toBe(92_361_055 + 44 + 3_497 + 113);
    expect(kokoroModel('fp32').sizeBytes).toBe(pinnedBytes(KOKORO_MODEL_REPO, ['onnx/model.onnx', 'config.json', 'tokenizer.json', 'tokenizer_config.json']));
  });

  it('covers every precision a recognition model offers', () => {
    for (const spec of Object.values(ASR_MODELS)) {
      for (const dtype of Object.keys(spec.bytes) as (keyof typeof spec.bytes)[]) {
        expect(spec.bytes[dtype]).toBe(pinnedBytes(spec.modelId, asrFiles(dtype)));
      }
    }
  });
});

describe('the addresses downloads use', () => {
  it('are the pinned ones', () => {
    expect(modelUrl(SILERO_VAD)).toBe(pinnedUrl(SILERO_VAD.repo, SILERO_VAD.file));
    expect(modelUrl(SMART_TURN.cpu)).toBe(pinnedUrl(SMART_TURN.cpu.repo, SMART_TURN.cpu.file));
    expect(FACE_MODEL_URL).toContain('/float16/1/');
    expect(SER_MODELS.base.revision).toBe(PINS[SER_MODELS.base.repo]?.revision);
  });

  it('cover every voice kokoro-js can ask for', () => {
    for (const voice of kokoroVoices) expect(() => pinnedFile(KOKORO_VOICES_REPO, `voices/${voice.id}.bin`)).not.toThrow();
  });
});

const worker = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url).href), 'utf8');

describe('the workers that import transformers.js', () => {
  it('Smart Turn runs ONNX Runtime from the build too, for all it only wants a feature extractor', () => {
    expect(worker('../turn/smart-turn.worker.ts')).toContain('ORT_WASM_PATHS');
  });

  it.each(['../kokoro/kokoro.worker.ts', '../asr/asr.worker.ts'])('%s runs ONNX Runtime from the build and guards its fetch', (path) => {
    const source = worker(path);
    expect(source).toContain('ORT_WASM_PATHS');
    expect(source).toContain('installPinnedFetch(');
    expect(source).toContain('verifyCachedFiles(');
    expect(source.indexOf('installPinnedFetch(')).toBeLessThan(source.indexOf('async function load('));
  });
});

describe('the registry', () => {
  it('has no two entries alike, and lists only what is pinned', () => {
    expect(new Set(REGISTRY.map((entry) => entry.id)).size).toBe(REGISTRY.length);
    for (const entry of REGISTRY) {
      expect(registryFiles(entry.sources).length, entry.id).toBeGreaterThan(0);
      expect(entry.licence, entry.id).not.toBe('');
      expect(entry.sizes.toSorted((a, b) => a - b), entry.id).toEqual(entry.sizes);
    }
  });

  it('accounts for every pin but the bodies, which the app adds with their own licence text', () => {
    const listed = new Set(REGISTRY.flatMap((entry) => entry.sources));
    expect(Object.keys(PINS).filter((key) => !listed.has(key))).toEqual(['pixiv/three-vrm', 'rickmcelvana/latentPresence']);
  });
});
