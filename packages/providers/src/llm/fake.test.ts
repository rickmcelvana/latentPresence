import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import { FakeLLMProvider } from './fake';

const request: LlmRequest = {
  modelId: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  temperature: null,
  maxOutputTokens: null,
};

describe('FakeLLMProvider', () => {
  it('replays a scripted stream verbatim, in order', async () => {
    const script: readonly LlmStreamChunk[] = [
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: null },
    ];
    const fake = new FakeLLMProvider('fake', { script });
    const collected: LlmStreamChunk[] = [];
    for await (const chunk of fake.stream(request)) collected.push(chunk);
    expect(collected).toEqual(script);
  });

  it('lists the fixture models and is empty by default', async () => {
    const withModels = new FakeLLMProvider('fake', {
      models: [{ id: 'm1', label: 'm1', capabilities: null, embeddingOnly: false }],
    });
    expect(await withModels.listModels()).toHaveLength(1);

    const bare = new FakeLLMProvider('bare');
    expect(await bare.listModels()).toEqual([]);
  });
});
