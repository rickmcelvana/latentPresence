import { describe, expect, it, vi } from 'vitest';
import type { LlmCapabilities, LlmModel, LLMProvider } from '@latentpresence/protocol';
import { googleCatalog, GoogleLLMProvider } from './google';

/** `LlmModel.capabilities` is nullable for the un-enriched `/v1/models` path (ADR-22).
 * The curated catalog is the enriched path, so null here is itself the defect — this
 * narrows for the type checker and fails loudly rather than skipping the assertion. */
function capabilitiesOf(model: LlmModel): LlmCapabilities {
  const capabilities = model.capabilities;
  if (capabilities === null) throw new Error(`${model.id} reports null capabilities`);
  return capabilities;
}

describe('GoogleLLMProvider', () => {
  it('listModels returns the curated catalog, capabilities non-null on every entry', async () => {
    const provider = new GoogleLLMProvider({ id: 'google' });
    const models = await provider.listModels();
    expect(models).toEqual(googleCatalog);
    for (const model of models) {
      expect(model.capabilities).not.toBeNull();
    }
  });

  it('every catalog model reports contextLength null', () => {
    for (const model of googleCatalog) {
      expect(capabilitiesOf(model).contextLength).toBeNull();
    }
  });

  it('reports promptCaching and thinking true on every catalog model', () => {
    for (const model of googleCatalog) {
      expect(capabilitiesOf(model).promptCaching).toBe(true);
      expect(capabilitiesOf(model).thinking).toBe(true);
    }
  });

  it('listModels makes no network call', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch should not be called');
    });
    const provider = new GoogleLLMProvider({ id: 'google', fetch: fetchSpy });
    await provider.listModels();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GoogleLLMProvider satisfies LLMProvider (id + listModels + stream)', () => {
    const provider: LLMProvider = new GoogleLLMProvider({ id: 'google' });
    expect(provider.id).toBe('google');
  });
});
