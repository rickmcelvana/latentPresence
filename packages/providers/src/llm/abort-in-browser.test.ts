import { afterEach, describe, expect, it } from 'vitest';
import type { LLMProvider, LlmRequest } from '@latentpresence/protocol';
import { AnthropicLLMProvider } from './anthropic';
import { GoogleLLMProvider } from './google';
import type { HttpFetch } from './discovery';
import { OpenAICompatibleLLMProvider } from './openai-compatible';

// Seen in Chrome and the desktop webview, C-9 (2026-11-03): each barge-in during thinking logged
// "Uncaught (in promise) AbortError". The AI SDK 7.0.97 hands its tracing a `.then` on the usage
// promise, and only catches it when `process.release.name` is 'node'; in a browser nobody does,
// so an aborted stream rejects it unhandled. Node never shows this, so these tests pretend.
const REQUEST: LlmRequest = {
  modelId: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  temperature: null,
  maxOutputTokens: null,
};

/** A model server that has said nothing yet, the state a person interrupts during thinking. */
const silent: HttpFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) return;
    signal.addEventListener('abort', () => reject(signal.reason));
  });

const PROVIDERS: readonly (readonly [string, () => LLMProvider])[] = [
  ['OpenAI-compatible', () => new OpenAICompatibleLLMProvider({ id: 't', baseUrl: 'http://127.0.0.1:1/v1', fetch: silent })],
  ['Anthropic', () => new AnthropicLLMProvider({ id: 't', apiKey: 'k', fetch: silent })],
  ['Google', () => new GoogleLLMProvider({ id: 't', apiKey: 'k', fetch: silent })],
];

/** This package is browser code with no Node types; the test alone runs on Node. */
const nodeProcess = (globalThis as unknown as {
  readonly process: {
    prependListener(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
    removeListener(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  };
}).process;
const realRelease = Object.getOwnPropertyDescriptor(nodeProcess, 'release');

describe('an aborted stream in a browser', () => {
  afterEach(() => {
    if (realRelease !== undefined) Object.defineProperty(nodeProcess, 'release', realRelease);
  });

  it.each(PROVIDERS)('%s leaves no unhandled rejection', async (_name, make) => {
    Object.defineProperty(nodeProcess, 'release', { value: { name: 'browser' }, configurable: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    nodeProcess.prependListener('unhandledRejection', onUnhandled);
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      for await (const part of make().stream(REQUEST, { signal: controller.signal })) void part;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      nodeProcess.removeListener('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
