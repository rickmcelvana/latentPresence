import { describe, expect, it } from 'vitest';
import type { LlmModel } from '@latentpresence/protocol';
import {
  LLM_ENDPOINT_OPTIONS,
  chattableModels,
  defaultBaseUrlFor,
  endpointLabel,
  endpointNeedsKeyField,
  listingFor,
} from './llm-endpoint';

describe('LLM_ENDPOINT_OPTIONS', () => {
  it('lists the eight presets, then Anthropic, then Google, then Custom, in order', () => {
    const kinds = LLM_ENDPOINT_OPTIONS.map((option) => option.kind);
    expect(kinds.filter((k) => k === 'preset')).toHaveLength(8);
    expect(kinds.slice(-3)).toEqual(['anthropic', 'google', 'custom']);
  });
});

describe('endpointLabel', () => {
  it('names a preset by its label, and the two native adapters and custom by hand', () => {
    expect(endpointLabel('lm-studio')).toBe('LM Studio');
    expect(endpointLabel('anthropic')).toBe('Anthropic');
    expect(endpointLabel('google')).toBe('Google');
    expect(endpointLabel('custom')).toBe('Custom (OpenAI-compatible)');
  });
});

describe('endpointNeedsKeyField', () => {
  it('is true for a preset that requires a key, both native adapters, and custom', () => {
    expect(endpointNeedsKeyField('nvidia')).toBe(true);
    expect(endpointNeedsKeyField('anthropic')).toBe(true);
    expect(endpointNeedsKeyField('google')).toBe(true);
    expect(endpointNeedsKeyField('custom')).toBe(true);
  });

  it('is false for a preset that does not require one', () => {
    expect(endpointNeedsKeyField('ollama')).toBe(false);
    expect(endpointNeedsKeyField('lm-studio')).toBe(false);
  });
});

describe('defaultBaseUrlFor', () => {
  it('fills a preset base URL, e.g. LM Studio', () => {
    expect(defaultBaseUrlFor('lm-studio')).toBe('http://127.0.0.1:1234/v1');
  });

  it('has none for Anthropic, Google or Custom', () => {
    expect(defaultBaseUrlFor('anthropic')).toBeNull();
    expect(defaultBaseUrlFor('google')).toBeNull();
    expect(defaultBaseUrlFor('custom')).toBeNull();
  });
});

describe('listingFor', () => {
  it('routes to the OpenAI-compatible /models for a preset or custom endpoint', () => {
    expect(listingFor('nvidia', 'https://integrate.api.nvidia.com/v1', 'k').url).toBe(
      'https://integrate.api.nvidia.com/v1/models',
    );
  });

  it('routes to the native listing for Anthropic and Google', () => {
    expect(listingFor('anthropic', '', 'k').url).toBe('https://api.anthropic.com/v1/models');
    expect(listingFor('google', '', 'k').url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  });
});

const chatModel = (id: string): LlmModel => ({ id, label: id, capabilities: null, embeddingOnly: false });
const embeddingModel = (id: string): LlmModel => ({ id, label: id, capabilities: null, embeddingOnly: true });

describe('chattableModels', () => {
  it('hides embedding-only models', () => {
    expect(chattableModels([chatModel('a'), embeddingModel('e'), chatModel('b')]).map((m) => m.id)).toEqual(['a', 'b']);
  });
});
