import { describe, expect, it } from 'vitest';
import {
  SILERO_VAD,
  SMART_TURN,
  modelUrl,
  sileroVadModel,
  smartTurnCombinationBlocker,
  smartTurnModel,
  type SmartTurnBackend,
  type SmartTurnBuild,
} from './messages';

describe('the turn model table', () => {
  /**
   * Pinned literally: these are the bytes the consent screen promises, read from the HF
   * tree API at the pinned revision on 2026-09-13. A change here is a change to what the
   * user agreed to download.
   */
  it('quotes the sizes that were verified', () => {
    expect(SILERO_VAD.bytes).toBe(2_243_022);
    expect(SMART_TURN.gpu.bytes).toBe(32_411_198);
    expect(SMART_TURN.cpu.bytes).toBe(8_679_182);
  });

  it('pins every URL to a commit, never to a moving branch', () => {
    for (const spec of [SILERO_VAD, SMART_TURN.gpu, SMART_TURN.cpu]) {
      expect(spec.revision).toMatch(/^[0-9a-f]{40}$/u);
      expect(modelUrl(spec)).toBe(`https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${spec.file}`);
      expect(modelUrl(spec)).not.toContain('/main/');
    }
  });

  it('names v3.2 for both Smart Turn builds, as Spike D measured', () => {
    expect(SMART_TURN.gpu.file).toBe('smart-turn-v3.2-gpu.onnx');
    expect(SMART_TURN.cpu.file).toBe('smart-turn-v3.2-cpu.onnx');
  });

  it('describes each model for the consent screen', () => {
    expect(sileroVadModel()).toMatchObject({ sizeBytes: 2_243_022, licence: 'MIT' });
    expect(smartTurnModel('gpu')).toMatchObject({ sizeBytes: 32_411_198, licence: 'BSD-2-Clause' });
    expect(smartTurnModel('gpu').id).not.toBe(smartTurnModel('cpu').id);
  });
});

describe('smartTurnCombinationBlocker', () => {
  it('refuses int8 on WebGPU and nothing else (ADR-21)', () => {
    const allowed: [SmartTurnBackend, SmartTurnBuild][] = [
      ['webgpu', 'gpu'],
      ['wasm', 'gpu'],
      ['wasm', 'cpu'],
    ];
    for (const [backend, build] of allowed) expect(smartTurnCombinationBlocker(backend, build)).toBeNull();
    expect(smartTurnCombinationBlocker('webgpu', 'cpu')).toMatch(/int8.*WebGPU/u);
  });
});
