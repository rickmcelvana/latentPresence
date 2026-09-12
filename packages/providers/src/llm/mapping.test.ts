import { describe, expect, it } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import type { LlmMessage } from '@latentpresence/protocol';
import {
  mapFinishReason,
  mapStreamPart,
  mapUsage,
  toAiMessages,
  toAiTools,
  type AiStreamPart,
} from './mapping';

const NOW = '2026-09-11T00:00:00.000Z';
const now = () => NOW;

describe('mapStreamPart', () => {
  it('maps text and reasoning deltas into their own variants', () => {
    const text = mapStreamPart({ type: 'text-delta', id: '1', text: 'Hello' } as AiStreamPart, now);
    expect(text).toEqual({ type: 'text-delta', text: 'Hello' });

    const reasoning = mapStreamPart(
      { type: 'reasoning-delta', id: '2', text: ' hmm' } as AiStreamPart,
      now,
    );
    expect(reasoning).toEqual({ type: 'reasoning-delta', text: ' hmm' });
  });

  it('maps a tool-call into our ToolCall shape', () => {
    const chunk = mapStreamPart(
      {
        type: 'tool-call',
        toolCallId: 'tc-1',
        toolName: 'search_documents',
        input: { query: 'x' },
      } as AiStreamPart,
      now,
    );
    expect(chunk).toEqual({
      type: 'tool-call',
      call: { id: 'tc-1', name: 'search_documents', arguments: { query: 'x' }, source: 'llm', requestedAt: NOW },
    });
  });

  it('maps finish (with usage), error and abort to terminal finish chunks', () => {
    const finish = mapStreamPart(
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      } as AiStreamPart,
      now,
    );
    expect(finish).toEqual({
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 0 },
    });

    const error = mapStreamPart({ type: 'error', error: new Error('boom') } as AiStreamPart, now);
    expect(error).toEqual({ type: 'finish', reason: 'error', usage: null });

    const abort = mapStreamPart({ type: 'abort' } as AiStreamPart, now);
    expect(abort).toEqual({ type: 'finish', reason: 'aborted', usage: null });
  });

  it('returns null for parts that carry no output', () => {
    const parts: AiStreamPart[] = [
      { type: 'text-start', id: '1' } as AiStreamPart,
      { type: 'text-end', id: '1' } as AiStreamPart,
      { type: 'start-step', request: {} as never, warnings: [] } as AiStreamPart,
      { type: 'start' } as AiStreamPart,
    ];
    for (const part of parts) {
      expect(mapStreamPart(part, now)).toBeNull();
    }
  });
});

describe('mapFinishReason / mapUsage', () => {
  it('maps only the reasons our union has', () => {
    expect(mapFinishReason('stop')).toBe('stop');
    expect(mapFinishReason('length')).toBe('length');
    expect(mapFinishReason('tool-calls')).toBe('tool-calls');
    // `aborted` is not a FinishReason; an abort arrives as its own `abort` part and is
    // mapped to a finish with reason 'aborted' in mapStreamPart.
    expect(mapFinishReason('content-filter')).toBe('error');
    expect(mapFinishReason('other')).toBe('error');
  });

  it('prefers an input-cache read over a write for the cached count', () => {
    const usage: LanguageModelUsage = {
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
      outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
    };
    expect(mapUsage(usage)).toEqual({ inputTokens: 5, outputTokens: 3, cachedInputTokens: 2 });
  });
});

describe('toAiTools', () => {
  it('builds a tool set keyed by tool name', () => {
    const set = toAiTools([
      { name: 'search', description: 'Search things.', parameters: { type: 'object', properties: {} } },
    ]);
    expect(Object.keys(set)).toEqual(['search']);
  });
});

describe('toAiMessages', () => {
  it('maps an assistant tool call and resolves the tool-result name from it', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'find it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'search', arguments: { q: 'x' }, source: 'llm', requestedAt: NOW },
        ],
      },
      { role: 'tool', callId: 'c1', content: { rows: 2 } },
    ];
    const ai = toAiMessages(messages);
    expect(ai).toHaveLength(4);
    expect(ai[0]).toMatchObject({ role: 'system', content: 'sys' });
    // The tool message must carry the name it needs to reach the wire, resolved from the
    // call, and the output as a typed `json` part (the AI SDK's ToolResultOutput shape).
    expect(ai[3]).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'search',
          output: { type: 'json', value: { rows: 2 } },
        },
      ],
    });
  });

  it('rejects a tool result with no preceding call in the history', () => {
    // A tool result without its request would be sent to the endpoint with no matching
    // call id, which every OpenAI-compatible server rejects. Fail here, with history in
    // hand, not in the middle of a stream.
    const messages: LlmMessage[] = [{ role: 'tool', callId: 'c1', content: { rows: 2 } }];
    expect(() => toAiMessages(messages)).toThrow('c1');
  });
});
