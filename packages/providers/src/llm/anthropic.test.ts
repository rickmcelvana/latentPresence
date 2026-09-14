import { describe, expect, it, vi } from 'vitest';
import type { LlmCapabilities, LlmModel, LLMProvider } from '@latentpresence/protocol';
import { ANTHROPIC_BROWSER_HEADER, anthropicCatalog, AnthropicLLMProvider } from './anthropic';

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

  // Live-confirmed 2026-09-12 against `GET /v1/models` -> `max_input_tokens`, which is
  // what turned these from doc-sourced into facts.
  it('catalog context lengths are the ones the live API states', () => {
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

  // Measured 2026-09-14: without this header a browser page gets "Failed to fetch".
  it('sends the browser-access header on every call, and a caller can still override it', async () => {
    const seen: Headers[] = [];
    const fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response('{"type":"error","error":{"type":"x","message":"stop"}}', { status: 400 });
    });
    const request = { modelId: 'claude-haiku-4-5', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], temperature: null, maxOutputTokens: null };
    const drain = async (provider: AnthropicLLMProvider): Promise<void> => {
      try {
        for await (const chunk of provider.stream(request)) {
          void chunk; // The 400 ends the stream; only the request headers matter here.
        }
      } catch {
        // Expected: the fake answers with an error.
      }
    };
    await drain(new AnthropicLLMProvider({ id: 'anthropic', apiKey: 'k', fetch: fetchSpy }));
    await drain(new AnthropicLLMProvider({ id: 'anthropic', apiKey: 'k', fetch: fetchSpy, headers: { [ANTHROPIC_BROWSER_HEADER]: 'false' } }));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]?.get(ANTHROPIC_BROWSER_HEADER)).toBe('true');
    expect(seen.at(-1)?.get(ANTHROPIC_BROWSER_HEADER)).toBe('false');
  });

  it('AnthropicLLMProvider satisfies LLMProvider (id + listModels + stream)', () => {
    const provider: LLMProvider = new AnthropicLLMProvider({ id: 'anthropic' });
    expect(provider.id).toBe('anthropic');
  });
});
