import { streamText } from 'ai';
import {
  createGoogleGenerativeAI,
  type GoogleProvider,
  type GoogleProviderSettings,
} from '@ai-sdk/google';
import type {
  CancellationSignal,
  LLMProvider,
  LlmModel,
  LlmRequest,
  LlmStreamChunk,
} from '@latentpresence/protocol';
import type { HttpFetch } from './discovery';
import { mapStreamPart, toAiMessages, toAiTools } from './mapping';

/** How a user configures the native Google Gemini endpoint (P1-T03). */
export interface GoogleConfig {
  /** Stable provider id, stored in settings. */
  readonly id: string;
  readonly apiKey?: string;
  /** Overrides the default `https://generativelanguage.googleapis.com/v1beta`. */
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  /** Injected transport for tests; defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
}

/**
 * The curated Gemini catalog.
 *
 * `contextLength` was `null` here until 2026-09-12, because the installed
 * `@ai-sdk/google` surface states no context window and SURFACE 11 forbids presenting a
 * guess as a fact. It is now **1048576 on all three, live-verified**: `GET /v1beta/models`
 * reports `inputTokenLimit` for every one of them (`docs/SURFACE.md`). The value is 2^20,
 * not the round 1000000 Anthropic reports for its own million-token models — which is
 * exactly why it was never worth guessing.
 *
 * Everything else here is documented in the provider's own capability table.
 */
export const googleCatalog: readonly LlmModel[] = [
  {
    id: 'gemini-3.8-flash',
    label: 'gemini-3.8-flash',
    capabilities: {
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      thinking: true,
      promptCaching: true,
      vision: true,
      contextLength: 1_048_576,
    },
    embeddingOnly: false,
  },
  {
    id: 'gemini-3.5-flash',
    label: 'gemini-3.5-flash',
    capabilities: {
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      thinking: true,
      promptCaching: true,
      vision: true,
      contextLength: 1_048_576,
    },
    embeddingOnly: false,
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'gemini-3.5-flash-lite',
    capabilities: {
      streaming: true,
      toolCalls: true,
      structuredOutput: true,
      thinking: true,
      promptCaching: true,
      vision: true,
      contextLength: 1_048_576,
    },
    embeddingOnly: false,
  },
];

/**
 * The native Google Gemini LLM provider, built on the AI SDK (ADR-04). Same contract as
 * `OpenAICompatibleLLMProvider` and `AnthropicLLMProvider`.
 */
export class GoogleLLMProvider implements LLMProvider {
  readonly id: string;
  private readonly config: GoogleConfig;
  private readonly now: () => string;

  constructor(config: GoogleConfig, now: () => string = () => new Date().toISOString()) {
    this.id = config.id;
    this.config = config;
    this.now = now;
  }

  /** The curated catalog. No network call: there is nothing to discover. */
  async listModels(): Promise<LlmModel[]> {
    return [...googleCatalog];
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

  private buildProvider(): GoogleProvider {
    const settings: GoogleProviderSettings = {};
    if (this.config.baseUrl !== undefined) settings.baseURL = this.config.baseUrl;
    if (this.config.apiKey !== undefined) settings.apiKey = this.config.apiKey;
    if (this.config.headers !== undefined) settings.headers = this.config.headers;
    if (this.config.fetch !== undefined) {
      settings.fetch = this.config.fetch as NonNullable<GoogleProviderSettings['fetch']>;
    }
    return createGoogleGenerativeAI(settings);
  }
}
