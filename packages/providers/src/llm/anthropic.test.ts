import { describe, expect, it, vi } from 'vitest';
import type { LlmCapabilities, LlmModel, LLMProvider } from '@latentpresence/protocol';
import { anthropicCatalog, AnthropicLLMProvider } from './anthropic';

/** `LlmModel.capabilities` is nullable for the un-enriched `/v1/models` path (ADR-22).
 * The curated catalog is the enriched path, so null here is itself the defect — this
 * narrows for the type checker and fails loudly rather than skipping the assertion. */
function capabilitiesOf(model: LlmModel): LlmCapabilities {
  const capabilities = model.capabilities;
  if (capabilities === null) throw new Error(`${model.id} reports null capabilities`);
  return capabilities;
}

describe('AnthropicLLMProvider', () => {
  it('listModels returns the curated catalog with capabilities on every entry', async () => {
    const provider = new AnthropicLLMProvider({ id: 'anthropic' });
    const models = await provider.listModels();
    expect(models).toEqual(anthropicCatalog);
    for (const model of models) {
      expect(model.capabilities).not.toBeNull();
      expect(model.embeddingOnly).toBe(false);
    }
  });

  it('reports promptCaching true on every catalog model', () => {
    for (const model of anthropicCatalog) {
      expect(capabilitiesOf(model).promptCaching).toBe(true);
    }
  });

  it('catalog context lengths are the documented ones', () => {
    for (const model of anthropicCatalog) {
      if (model.id === 'claude-haiku-4-5') {
        expect(capabilitiesOf(model).contextLength).toBe(200000);
      } else {
        expect(capabilitiesOf(model).contextLength).toBe(1000000);
      }
    }
  });

  it('listModels makes no network call', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch should not be called');
    });
    const provider = new AnthropicLLMProvider({ id: 'anthropic', fetch: fetchSpy });
    await provider.listModels();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AnthropicLLMProvider satisfies LLMProvider (id + listModels + stream)', () => {
    const provider: LLMProvider = new AnthropicLLMProvider({ id: 'anthropic' });
    expect(provider.id).toBe('anthropic');
  });
});
