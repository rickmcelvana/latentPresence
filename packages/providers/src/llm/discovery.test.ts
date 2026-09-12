import { describe, expect, it } from 'vitest';
import type { LlmModel } from '@latentpresence/protocol';
import {
  discoverModels,
  ollamaModels,
  ollamaRootFromOpenAiBaseUrl,
  v1Models,
  type HttpFetch,
} from './discovery';

import ollamaTags from './__fixtures__/ollama-tags.json';

/** A fake `fetch` answering specific URLs. */
function fetchStub(routes: Record<string, { status: number; body: string }>): HttpFetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body, { status: route.status });
  };
}

const tags = JSON.stringify(ollamaTags);
const version = JSON.stringify({ version: '0.32.15' });

describe('ollamaRootFromOpenAiBaseUrl', () => {
  it('derives an Ollama root from a /v1 base URL', () => {
    expect(ollamaRootFromOpenAiBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(ollamaRootFromOpenAiBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434');
    expect(ollamaRootFromOpenAiBaseUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api');
  });

  it('returns null when the URL is not Ollama-shaped', () => {
    expect(ollamaRootFromOpenAiBaseUrl('http://host/api')).toBeNull();
    expect(ollamaRootFromOpenAiBaseUrl('http://127.0.0.1:11434')).toBeNull();
  });
});

describe('ollamaModels (enriched discovery)', () => {
  const fake = fetchStub({
    'http://localhost:11434/api/tags': { status: 200, body: tags },
  });

  it('marks an embedding model so the chat picker can hide it', async () => {
    const models: LlmModel[] = await ollamaModels(fake, 'http://localhost:11434');
    const embed = models.find((m) => m.id === 'nomic-embed-text:latest');
    const chat = models.find((m) => m.id === 'gemma4:12b-it-qat');
    expect(embed?.embeddingOnly).toBe(true);
    expect(embed?.capabilities?.thinking).toBe(false);
    expect(chat?.embeddingOnly).toBe(false);
    expect(chat?.capabilities?.thinking).toBe(true);
    expect(chat?.capabilities?.contextLength).toBe(262144);
    expect(chat).toBeDefined();
  });

  it('keeps capabilities non-null because /api/tags enriched them', async () => {
    const models = await ollamaModels(fake, 'http://localhost:11434');
    expect(models.every((m) => m.capabilities !== null)).toBe(true);
  });
});

describe('v1Models (un-enriched fallback)', () => {
  const list = JSON.stringify({
    object: 'list',
    data: [{ id: 'kimi-k3:cloud' }, { id: 'gemma4:12b-32k' }],
  });
  const fake = fetchStub({ 'http://127.0.0.1:11434/v1/models': { status: 200, body: list } });

  it('returns ids in wire order with null capabilities (ADR-22)', async () => {
    const models = await v1Models(fake, 'http://127.0.0.1:11434/v1');
    expect(models.map((m) => m.id)).toEqual(['kimi-k3:cloud', 'gemma4:12b-32k']);
    expect(models.every((m) => m.capabilities === null)).toBe(true);
  });
});

describe('discoverModels', () => {
  it('uses the Ollama native layer when /api/version confirms it', async () => {
    const fake = fetchStub({
      'http://localhost:11434/api/version': { status: 200, body: version },
      'http://localhost:11434/api/tags': { status: 200, body: tags },
    });
    const result = await discoverModels(fake, 'http://localhost:11434/v1');
    expect(result.source).toBe('ollama');
    expect(result.models.some((m) => m.id === 'gemma4:12b-it-qat')).toBe(true);
  });

  it('falls back to /v1/models for a /v1 base URL that is not Ollama', async () => {
    const list = JSON.stringify({ object: 'list', data: [{ id: 'm1' }] });
    const fake = fetchStub({ 'http://host/v1/models': { status: 200, body: list } });
    const result = await discoverModels(fake, 'http://host/v1');
    expect(result.source).toBe('openai');
    expect(result.models[0]?.capabilities).toBeNull();
  });
});
