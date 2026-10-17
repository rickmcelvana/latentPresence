import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from './openai-compatible';

describe('OpenAICompatibleLLMProvider', () => {
  // R-56 (2026-10-17): DeepSeek and Qwen passed the connection test, then the listing said
  // "v1/models 401" — the probe sent the key and the listing did not.
  it('lists models with the key and headers a completion would carry', async () => {
    const seen: Headers[] = [];
    const provider = new OpenAICompatibleLLMProvider({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-1',
      headers: { 'x-extra': 'e' },
      fetch: async (_url, init) => {
        seen.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 });
      },
    });
    expect((await provider.listModels()).map((model) => model.id)).toEqual(['deepseek-chat']);
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.get('authorization')).toBe('Bearer sk-1');
      expect(headers.get('x-extra')).toBe('e');
    }
  });

  it('lists models with no authorization header when there is no key', async () => {
    const seen: Headers[] = [];
    const provider = new OpenAICompatibleLLMProvider({
      id: 'lm-studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      fetch: async (_url, init) => {
        seen.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      },
    });
    await provider.listModels();
    expect(seen.every((headers) => !headers.has('authorization'))).toBe(true);
  });

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

  it('asks for no reasoning when the request says so, and says nothing otherwise (ADR-37)', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = new OpenAICompatibleLLMProvider({
      id: 'ollama',
      baseUrl: 'http://127.0.0.1:1/v1',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const request: LlmRequest = { modelId: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], temperature: null, maxOutputTokens: null };
    for await (const chunk of provider.stream({ ...request, reasoning: 'off' })) void chunk;
    for await (const chunk of provider.stream(request)) void chunk;

    expect(bodies[0]?.reasoning_effort).toBe('none');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });
});
