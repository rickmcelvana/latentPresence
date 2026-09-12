import { describe, expect, it } from 'vitest';
import { llmPresets, presetById } from './presets';

describe('llmPresets', () => {
  it('includes every endpoint the plan lists (P1-T02)', () => {
    const ids = llmPresets.map((p) => p.id);
    for (const id of [
      'ollama',
      'lm-studio',
      'vllm',
      'llama-cpp',
      'openrouter',
      'nvidia',
      'deepseek',
      'kimi',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('uses the exact NVIDIA base URL from the plan', () => {
    expect(presetById('nvidia')?.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
  });

  it('flags cloud endpoints as needing a key and local ones not', () => {
    expect(presetById('ollama')?.requiresApiKey).toBe(false);
    expect(presetById('lm-studio')?.requiresApiKey).toBe(false);
    expect(presetById('nvidia')?.requiresApiKey).toBe(true);
    expect(presetById('openrouter')?.requiresApiKey).toBe(true);
    expect(presetById('deepseek')?.requiresApiKey).toBe(true);
    expect(presetById('kimi')?.requiresApiKey).toBe(true);
  });

  it('has unique ids', () => {
    const ids = llmPresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only Ollama enables the native enrichment layer (ADR-22)', () => {
    for (const preset of llmPresets) {
      if (preset.id === 'ollama') {
        expect(preset.native).toBe('ollama');
      } else {
        expect(preset.native).toBeUndefined();
      }
    }
  });
});
