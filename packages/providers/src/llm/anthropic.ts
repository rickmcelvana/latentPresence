import { streamText } from 'ai';
import {
  createAnthropic,
  type AnthropicProvider,
  type AnthropicProviderSettings,
} from '@ai-sdk/anthropic';
import type {
  CancellationSignal,
  LLMProvider,
  LlmModel,
  LlmRequest,
  LlmStreamChunk,
} from '@latentpresence/protocol';
import type { HttpFetch } from './discovery';
import { mapStreamPart, toAiMessages, toAiTools } from './mapping';

/** How a user configures the native Anthropic endpoint (P1-T03). `apiKey` is a BYO key
 * from the settings key store, never from this object's own rendering; `baseUrl` is only
 * for a proxy, since the provider already knows the real one. */
export interface AnthropicConfig {
  /** Stable provider id, stored in settings. */
  readonly id: string;
  readonly apiKey?: string;
  /** Overrides the default `https://api.anthropic.com/v1`, for proxies. */
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  /** Injected transport for tests; defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
}

/**
 * The models this provider offers. Native Anthropic has no browser-reachable listing
 * endpoint, so the catalog is curated rather than discovered — and because it is curated
 * it is the enriched path, with `capabilities` always non-null (ADR-22 covers the
 * opposite case, the un-enriched `/v1/models` list).
 */
export const anthropicCatalog: readonly LlmModel[] = [
  {
    // Added 2026-09-12 after `GET /v1/models` showed it. Every flag below was confirmed
    // by a live call rather than inherited from the family: it answered a question about
    // an image, accepted `cache_control` and reported the ephemeral cache buckets, and
    // its usage carries `output_tokens_details.thinking_tokens`.
    // `claude-fable-5` is deliberately absent for the same reason `claude-sonnet-4-5` is —
    // it is the previous point release, and this catalog is current-generation only.
    id: 'claude-fable-5-1',
    label: 'claude-fable-5-1',
    capabilities: {
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      thinking: true,
      promptCaching: true,
      vision: true,
      contextLength: 1000000,
    },
    embeddingOnly: false,
  },
  {
    id: 'claude-opus-5',
    label: 'claude-opus-5',
    capabilities: {
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      thinking: true,
      promptCaching: true,
      vision: true,
      contextLength: 1000000,
    },
    embeddingOnly: false,
  },
  {
    id: 'claude-sonnet-5',
    label: 'claude-sonnet-5',
    capabilities: {
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      thinking: true,
      promptCaching: true,
      vision: true,
      contextLength: 1000000,
    },
    embeddingOnly: false,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'claude-haiku-4-5',
    capabilities: {
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      thinking: true,
      promptCaching: true,
      vision: true,
      contextLength: 200000,
    },
    embeddingOnly: false,
  },
];

/**
 * The native Anthropic LLM provider, built on the AI SDK (ADR-04). Same contract as
 * `OpenAICompatibleLLMProvider`: the AI SDK owns the wire format, this class owns the
 * bridge to the protocol's shapes. Prompt caching is the flag that earns the native
 * adapter its place — the OpenAI-compatible path cannot report it.
 */
export class AnthropicLLMProvider implements LLMProvider {
  readonly id: string;
  private readonly config: AnthropicConfig;
  private readonly now: () => string;

  constructor(config: AnthropicConfig, now: () => string = () => new Date().toISOString()) {
    this.id = config.id;
    this.config = config;
    this.now = now;
  }

  /** The curated catalog. No network call: there is nothing to discover. */
  async listModels(): Promise<LlmModel[]> {
    return [...anthropicCatalog];
  }

  /** Stream a chat completion as protocol chunks. Cancellation (barge-in) aborts the
   * underlying fetch by wiring the caller's `signal` to an `AbortController`. */
  async *stream(
    request: LlmRequest,
    options?: { signal?: CancellationSignal },
  ): AsyncIterable<LlmStreamChunk> {
    const model = this.buildProvider()(request.modelId);

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options?.signal?.addEventListener('abort', onAbort);
    try {
      const result = streamText({
        model,
        messages: toAiMessages(request.messages),
        tools: toAiTools(request.tools),
        abortSignal: controller.signal,
        ...(request.temperature !== null ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== null ? { maxOutputTokens: request.maxOutputTokens } : {}),
      });
      for await (const part of result.fullStream) {
        const chunk = mapStreamPart(part, this.now);
        if (chunk !== null) yield chunk;
      }
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }

  private buildProvider(): AnthropicProvider {
    const settings: AnthropicProviderSettings = {};
    if (this.config.baseUrl !== undefined) settings.baseURL = this.config.baseUrl;
    if (this.config.apiKey !== undefined) settings.apiKey = this.config.apiKey;
    if (this.config.headers !== undefined) settings.headers = this.config.headers;
    if (this.config.fetch !== undefined) {
      settings.fetch = this.config.fetch as NonNullable<AnthropicProviderSettings['fetch']>;
    }
    return createAnthropic(settings);
  }
}
