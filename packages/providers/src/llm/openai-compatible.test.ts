import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from './openai-compatible';

describe('OpenAICompatibleLLMProvider', () => {
  // AI SDK 7 threw InvalidPromptError for any `system` message before a request was sent
  // (2026-09-14): a persona would have failed on every endpoint. It must reach the wire.
  it('sends a system prompt to the endpoint as the first message', async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAICompatibleLLMProvider({
      id: 'test',
      baseUrl: 'http://127.0.0.1:1/v1',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const request: LlmRequest = {
      modelId: 'm',
      messages: [
        { role: 'system', content: 'You are Alice.' },
        { role: 'user', content: 'hi' },
      ],
      tools: [],
      temperature: null,
      maxOutputTokens: null,
    };
    for await (const chunk of provider.stream(request)) void chunk;

    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { messages: unknown[] }).messages).toEqual([
      { role: 'system', content: 'You are Alice.' },
      { role: 'user', content: 'hi' },
    ]);
  });
});
