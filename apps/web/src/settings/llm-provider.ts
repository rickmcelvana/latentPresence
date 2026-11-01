import type { LLMProvider } from '@latentpresence/protocol';
import { AnthropicLLMProvider, GoogleLLMProvider, OpenAICompatibleLLMProvider, type HttpFetch } from '@latentpresence/providers/web';

/**
 * The provider for an endpoint id. **Its own module, imported where it is first needed**
 * (P9-T02): it is the only thing in the settings that reaches the AI SDK, so `/welcome` and
 * `/settings`, which import `llm-endpoint` for its labels, do not download the SDK before
 * they draw. Callers `import()` it.
 *
 * Wired to the transport `resolveTransport` resolved (plain, or relayed through the companion).
 */
export function buildLlmProvider(endpointId: string, baseUrl: string, apiKey: string | null, fetchFn: HttpFetch): LLMProvider {
  if (endpointId === 'anthropic') {
    return new AnthropicLLMProvider(apiKey === null ? { id: endpointId, fetch: fetchFn } : { id: endpointId, apiKey, fetch: fetchFn });
  }
  if (endpointId === 'google') {
    return new GoogleLLMProvider(apiKey === null ? { id: endpointId, fetch: fetchFn } : { id: endpointId, apiKey, fetch: fetchFn });
  }
  return new OpenAICompatibleLLMProvider(
    apiKey === null ? { id: endpointId, baseUrl, fetch: fetchFn } : { id: endpointId, baseUrl, apiKey, fetch: fetchFn },
  );
}
