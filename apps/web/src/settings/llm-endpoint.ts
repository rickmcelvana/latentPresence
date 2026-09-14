import type { LLMProvider, LlmModel } from '@latentpresence/protocol';
import {
  AnthropicLLMProvider,
  GoogleLLMProvider,
  OpenAICompatibleLLMProvider,
  llmPresets,
  presetById,
  type HttpFetch,
} from '@latentpresence/providers/web';
import {
  anthropicListing,
  googleListing,
  openAiCompatibleListing,
  type ProbeContext,
} from './connection';

/**
 * What the language-model section needs to know about the endpoint the user picked, in
 * one place: the id `llmPresets` and `Settings.llm.endpoint` share, plus the two native
 * ids and `'custom'` (P1-T10).
 */
export type LlmEndpointOption =
  | { readonly kind: 'preset'; readonly id: string; readonly label: string; readonly baseUrl: string; readonly requiresApiKey: boolean; readonly hint: string | null }
  | { readonly kind: 'anthropic' }
  | { readonly kind: 'google' }
  | { readonly kind: 'custom' };

/** Every choice the endpoint picker offers, in the brief's order: the eight presets,
 * then Anthropic, Google, then Custom. */
export const LLM_ENDPOINT_OPTIONS: readonly LlmEndpointOption[] = [
  ...llmPresets.map(
    (preset): LlmEndpointOption => ({
      kind: 'preset',
      id: preset.id,
      label: preset.label,
      baseUrl: preset.baseUrl,
      requiresApiKey: preset.requiresApiKey,
      hint: preset.hint ?? null,
    }),
  ),
  { kind: 'anthropic' },
  { kind: 'google' },
  { kind: 'custom' },
];

export function endpointLabel(endpointId: string): string {
  if (endpointId === 'anthropic') return 'Anthropic';
  if (endpointId === 'google') return 'Google';
  if (endpointId === 'custom') return 'Custom (OpenAI-compatible)';
  return presetById(endpointId)?.label ?? endpointId;
}

/** Whether the key field should show at all: presets that need one, or either native
 * adapter, or (optionally) a custom endpoint. */
export function endpointNeedsKeyField(endpointId: string): boolean {
  if (endpointId === 'anthropic' || endpointId === 'google' || endpointId === 'custom') return true;
  return presetById(endpointId)?.requiresApiKey === true;
}

/** The default base URL to fill in when a preset is picked; `null` for Anthropic and
 * Google, which have none to edit. */
export function defaultBaseUrlFor(endpointId: string): string | null {
  if (endpointId === 'anthropic' || endpointId === 'google' || endpointId === 'custom') return null;
  return presetById(endpointId)?.baseUrl ?? null;
}

/** The `GET .../models` request this endpoint is tested with, and the URL an
 * `LLMProvider` for it is built against. */
export function listingFor(endpointId: string, baseUrl: string, apiKey: string | null): { url: string; headers: Record<string, string> } {
  if (endpointId === 'anthropic') return anthropicListing(apiKey);
  if (endpointId === 'google') return googleListing(apiKey);
  return openAiCompatibleListing(baseUrl, apiKey);
}

/** Build the `LLMProvider` for a probed endpoint, wired to the transport `resolveTransport`
 * resolved (plain, or relayed through the companion). */
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

export function probeContextFor(endpointId: string, url: string, origin: string, hasKey: boolean): ProbeContext {
  return { endpointId, label: endpointLabel(endpointId), url, origin, hasKey };
}

/** Models fit to offer in the chat picker: embedding-only models are hidden rather than
 * offered and failing (ADR-22's other half). */
export function chattableModels(models: readonly LlmModel[]): LlmModel[] {
  return models.filter((model) => !model.embeddingOnly);
}
