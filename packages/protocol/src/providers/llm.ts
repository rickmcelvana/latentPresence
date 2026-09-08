import { z } from 'zod';
import { LlmCapabilitiesSchema } from '../capabilities';
import { IdSchema, JsonObjectSchema, JsonValueSchema } from '../common';
import { ToolCallSchema } from '../conversation';
import type { ProviderCallOptions } from './shared';

/** One message in the context sent to a model. */
export const LlmMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(ToolCallSchema),
  }),
  z.object({ role: z.literal('tool'), callId: IdSchema, content: JsonValueSchema }),
]);
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

/** A tool offered to the model. `parameters` is JSON Schema, as MCP and the APIs expect. */
export const LlmToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: JsonObjectSchema,
});
export type LlmTool = z.infer<typeof LlmToolSchema>;

export const LlmRequestSchema = z.object({
  modelId: z.string().min(1),
  messages: z.array(LlmMessageSchema).min(1),
  tools: z.array(LlmToolSchema),
  /** null leaves it to the backend, which is not the same as 0. */
  temperature: z.number().min(0).max(2).nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
});
export type LlmRequest = z.infer<typeof LlmRequestSchema>;

export const LlmUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Tokens served from a prompt cache, where the provider reports it. */
  cachedInputTokens: z.number().int().min(0).nullable(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export const LlmFinishReasonSchema = z.enum(['stop', 'length', 'tool-calls', 'aborted', 'error']);
export type LlmFinishReason = z.infer<typeof LlmFinishReasonSchema>;

/**
 * One piece of a streamed answer. Reasoning is a separate variant from text because it
 * must never be spoken or written to the transcript, only shown in the inner-monologue
 * panel if the user opens it.
 */
export const LlmStreamChunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('reasoning-delta'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), call: ToolCallSchema }),
  z.object({
    type: z.literal('finish'),
    reason: LlmFinishReasonSchema,
    usage: LlmUsageSchema.nullable(),
  }),
]);
export type LlmStreamChunk = z.infer<typeof LlmStreamChunkSchema>;

/** A model as discovery found it (P1-T02). */
export const LlmModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  capabilities: LlmCapabilitiesSchema,
  /**
   * Ollama and LM Studio list embedding models on the same endpoint as chat models.
   * The chat picker hides these instead of letting a user pick one and get nothing.
   */
  embeddingOnly: z.boolean(),
});
export type LlmModel = z.infer<typeof LlmModelSchema>;

/**
 * Any text model, wherever it runs. Adapters exist for OpenAI-compatible endpoints
 * (P1-T02) and for Anthropic and Google natively (P1-T03); every one of them ships a
 * `FakeLLMProvider` that replays a scripted stream.
 */
export interface LLMProvider {
  readonly id: string;
  /** What the endpoint offers. Discovery, not a guess from the provider name. */
  listModels(): Promise<LlmModel[]>;
  stream(request: LlmRequest, options?: ProviderCallOptions): AsyncIterable<LlmStreamChunk>;
}
