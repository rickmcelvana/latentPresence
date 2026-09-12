import {
  jsonSchema,
  tool,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type TextStreamPart,
  type Tool,
} from 'ai';
import type {
  LlmFinishReason,
  LlmMessage,
  LlmStreamChunk,
  LlmTool,
  LlmUsage,
  JsonObject,
} from '@latentpresence/protocol';

/** A tool set with unconstrained names, the shape `streamText({ tools })` wants. */
export type AiToolSet = Record<string, Tool>;
/** A stream part from `streamText().fullStream`, our tool shape. */
export type AiStreamPart = TextStreamPart<AiToolSet>;

/** JSON Schema a tool's `parameters` must be; the `jsonSchema()` argument type. */
export type AiJsonSchema = Parameters<typeof jsonSchema>[0];

/** Convert the tools we offer the model into the AI SDK's tool set. */
export function toAiTools(tools: LlmTool[]): AiToolSet {
  const result: AiToolSet = {};
  for (const t of tools) {
    result[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as AiJsonSchema),
    });
  }
  return result;
}

/**
 * Convert our protocol messages into the AI SDK's `messages`. The tool-name problem: the
 * AI SDK requires each tool result part to carry the tool's name, but our tool message
 * only carries the call id — so the name is looked up from the assistant turn that made
 * the call. A tool result with no preceding call is a history error the request cannot
 * survive, and surfaces as an error rather than a malformed payload to the endpoint.
 */
export function toAiMessages(messages: LlmMessage[]): ModelMessage[] {
  const callNames = new Map<string, string>();
  const out: ModelMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content });
        break;
      case 'user':
        out.push({ role: 'user', content: message.content });
        break;
      case 'assistant': {
        for (const call of message.toolCalls) {
          callNames.set(call.id, call.name);
        }
        if (message.toolCalls.length > 0) {
          out.push({
            role: 'assistant',
            content: [
              { type: 'text', text: message.content },
              ...message.toolCalls.map((call) => ({
                type: 'tool-call' as const,
                toolCallId: call.id,
                toolName: call.name,
                input: call.arguments,
              })),
            ],
          });
        } else {
          out.push({ role: 'assistant', content: message.content });
        }
        break;
      }
      case 'tool': {
        const toolName = callNames.get(message.callId);
        if (toolName === undefined) {
          throw new Error(`tool result ${message.callId} has no preceding tool call`);
        }
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result' as const,
              toolCallId: message.callId,
              toolName,
              output: { type: 'json' as const, value: message.content },
            },
          ],
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Map one AI SDK `fullStream` part to our own chunk. Anything that does not carry output
 * for us — `start`, `finish-step`, `text-start`/`text-end`, `tool-input-*` — yields
 * `null`, and the caller skips it. `error` and `abort` collapse into a terminal
 * `finish` chunk because our stream has no variant of their own for a mid-flight stop.
 */
export function mapStreamPart(part: AiStreamPart, now: () => string): LlmStreamChunk | null {
  switch (part.type) {
    case 'text-delta':
      return { type: 'text-delta', text: part.text };
    case 'reasoning-delta':
      return { type: 'reasoning-delta', text: part.text };
    case 'tool-call':
      return {
        type: 'tool-call',
        call: {
          id: part.toolCallId,
          name: part.toolName,
          arguments: part.input as JsonObject,
          source: 'llm',
          requestedAt: now(),
        },
      };
    case 'finish':
      return { type: 'finish', reason: mapFinishReason(part.finishReason), usage: mapUsage(part.totalUsage) };
    case 'error':
      return { type: 'finish', reason: 'error', usage: null };
    case 'abort':
      return { type: 'finish', reason: 'aborted', usage: null };
    default:
      return null;
  }
}

export function mapFinishReason(reason: FinishReason): LlmFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
      return 'tool-calls';
    default:
      // content-filter, error, other: not a clean stop and not a length truncation we
      // can retry; surface as a terminal error.
      return 'error';
  }
}

export function mapUsage(usage: LanguageModelUsage): LlmUsage {
  const details = usage.inputTokenDetails;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: details?.cacheReadTokens ?? details?.cacheWriteTokens ?? 0,
  };
}
