import { streamText } from 'ai';
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from '@ai-sdk/openai-compatible';
import type {
  CancellationSignal,
  LLMProvider,
  LlmModel,
  LlmRequest,
  LlmStreamChunk,
} from '@latentpresence/protocol';
import { discoverModels, type HttpFetch } from './discovery';
import { mapStreamPart, toAiMessages, toAiTools } from './mapping';

/** How a user configures one OpenAI-compatible endpoint (P1-T02). The base URL is the
 * `/v1` prefix; `apiKey` is optional for local servers and comes from the key store in
 * the settings UI, never from this object's own rendering. */
export interface OpenAICompatibleConfig {
  /** Stable provider id, matched to an `LLMPreset` when present. */
  readonly id: string;
  /** Trailing-slash tolerant `/v1` base URL. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  /** Injected transport for tests; defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
}

/**
 * The OpenAI-compatible LLM provider, built on the AI SDK (ADR-04). One implementation
 * covers Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, NVIDIA, DeepSeek and Kimi. The
 * AI SDK owns the SSE framing and the reasoning/text split; this class owns the bridge
 * to the protocol's shapes and the discovery.
 */
export class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly id: string;
  private readonly config: OpenAICompatibleConfig;
  private readonly now: () => string;

  constructor(config: OpenAICompatibleConfig, now: () => string = () => new Date().toISOString()) {
    this.id = config.id;
    this.config = config;
    this.now = now;
  }

  /** Models the endpoint offers, enriched when it is Ollama (capabilities known) and
   * `null`-capabilities otherwise (ADR-22). */
  async listModels(): Promise<LlmModel[]> {
    const fetchFn = this.config.fetch ?? fetch;
    const { models } = await discoverModels(fetchFn, this.config.baseUrl);
    return models;
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

  private buildProvider(): ReturnType<typeof createOpenAICompatible> {
    const settings: OpenAICompatibleProviderSettings = {
      name: this.config.id,
      baseURL: this.config.baseUrl,
      includeUsage: true,
    };
    if (this.config.apiKey !== undefined) settings.apiKey = this.config.apiKey;
    if (this.config.headers !== undefined) settings.headers = this.config.headers;
    if (this.config.fetch !== undefined) {
      settings.fetch = this.config.fetch as NonNullable<OpenAICompatibleProviderSettings['fetch']>;
    }
    return createOpenAICompatible(settings) as ReturnType<typeof createOpenAICompatible>;
  }
}
