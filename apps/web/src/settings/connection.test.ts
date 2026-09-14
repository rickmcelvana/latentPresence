import { describe, expect, it, vi } from 'vitest';
import type { LlmStreamChunk } from '@latentpresence/protocol';
import { DEFAULT_COMPANION_URL, RELAY_TARGET_HEADER } from '@latentpresence/providers/web';
import {
  anthropicListing,
  googleListing,
  isLocalHost,
  messageForProbe,
  openAiCompatibleListing,
  resolveTransport,
  runTestMessage,
  type ProbeContext,
} from './connection';

const ORIGIN = 'http://localhost:5173';

function ctx(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    endpointId: 'lm-studio',
    label: 'LM Studio',
    url: 'http://127.0.0.1:1234/v1/models',
    origin: ORIGIN,
    hasKey: false,
    ...overrides,
  };
}

describe('messageForProbe — the outcome table', () => {
  it('answered 2xx: Connected', () => {
    expect(messageForProbe({ kind: 'answered', status: 200 }, ctx())).toEqual({ tone: 'ok', text: 'Connected.' });
  });

  it('answered 2xx on NVIDIA or OpenRouter adds the key caveat', () => {
    for (const endpointId of ['nvidia', 'openrouter']) {
      expect(messageForProbe({ kind: 'answered', status: 200 }, ctx({ endpointId }))).toEqual({
        tone: 'ok',
        text: 'Connected. The key is checked when you send a test message.',
      });
    }
  });

  it('answered 401: the key was refused', () => {
    expect(messageForProbe({ kind: 'answered', status: 401 }, ctx({ hasKey: true }))).toEqual({
      tone: 'danger',
      text: 'The key was refused.',
    });
  });

  it('answered 403 with no key saved: needs a key', () => {
    expect(messageForProbe({ kind: 'answered', status: 403 }, ctx({ hasKey: false }))).toEqual({
      tone: 'warn',
      text: 'This endpoint needs a key.',
    });
  });

  it('answered 403 with a key saved: the key was refused', () => {
    expect(messageForProbe({ kind: 'answered', status: 403 }, ctx({ hasKey: true }))).toEqual({
      tone: 'danger',
      text: 'The key was refused.',
    });
  });

  it('answered 400 from Google counts as a refused key', () => {
    expect(messageForProbe({ kind: 'answered', status: 400 }, ctx({ endpointId: 'google', hasKey: true }))).toEqual({
      tone: 'danger',
      text: 'The key was refused.',
    });
  });

  it('answered 400 from anything else is just "the server answered 400"', () => {
    expect(messageForProbe({ kind: 'answered', status: 400 }, ctx({ endpointId: 'lm-studio' }))).toEqual({
      tone: 'danger',
      text: 'The server answered 400.',
    });
  });

  it('answered 404: nothing at this address', () => {
    expect(messageForProbe({ kind: 'answered', status: 404 }, ctx())).toEqual({
      tone: 'danger',
      text: 'Nothing at this address. The base URL usually ends in /v1.',
    });
  });

  it('answered other: the server answered <status>', () => {
    expect(messageForProbe({ kind: 'answered', status: 503 }, ctx())).toEqual({
      tone: 'danger',
      text: 'The server answered 503.',
    });
  });

  it('cors-blocked with help: uses corsHelp verbatim', () => {
    const result = messageForProbe({ kind: 'cors-blocked' }, ctx({ endpointId: 'lm-studio' }));
    expect(result.tone).toBe('warn');
    expect(result.text).toContain('CORS');
    expect(result.help?.steps.join('\n')).toContain('Enable CORS');
  });

  it('cors-blocked with no help (a custom endpoint): the generic message', () => {
    const result = messageForProbe({ kind: 'cors-blocked' }, ctx({ endpointId: 'custom', url: 'http://x/v1/models' }));
    expect(result).toEqual({
      tone: 'warn',
      text: `The server is running but does not allow this page (${ORIGIN}). Allow that origin in its CORS settings.`,
    });
  });

  it('unreachable, local host: asks if the label is running', () => {
    expect(messageForProbe({ kind: 'unreachable' }, ctx({ url: 'http://127.0.0.1:1234/v1/models', label: 'LM Studio' }))).toEqual({
      tone: 'danger',
      text: 'Nothing is answering at http://127.0.0.1:1234/v1/models. Is LM Studio running?',
    });
  });

  it('unreachable, remote host: check the address', () => {
    expect(messageForProbe({ kind: 'unreachable' }, ctx({ url: 'https://api.deepseek.com/v1/models', endpointId: 'deepseek' }))).toEqual({
      tone: 'danger',
      text: 'Could not reach api.deepseek.com. Check the address and your connection.',
    });
  });

  it('timeout: no answer within 5 seconds', () => {
    expect(messageForProbe({ kind: 'timeout' }, ctx({ url: 'http://10.0.0.1:1234/v1/models' }))).toEqual({
      tone: 'danger',
      text: 'No answer within 5 seconds from http://10.0.0.1:1234/v1/models.',
    });
  });
});

describe('isLocalHost', () => {
  it('recognises every documented local host', () => {
    for (const host of ['http://localhost:5173', 'http://127.0.0.1:11434', 'http://0.0.0.0:8000', 'http://[::1]:8787']) {
      expect(isLocalHost(host), host).toBe(true);
    }
  });

  it('rejects a remote host', () => {
    expect(isLocalHost('https://api.deepseek.com/v1')).toBe(false);
  });
});

describe('listing request builders', () => {
  it('OpenAI-compatible: no key means no Authorization header', () => {
    expect(openAiCompatibleListing('http://127.0.0.1:1234/v1/', null)).toEqual({
      url: 'http://127.0.0.1:1234/v1/models',
      headers: {},
    });
  });

  it('OpenAI-compatible: a key becomes Bearer', () => {
    expect(openAiCompatibleListing('http://x/v1', 'k').headers).toEqual({ authorization: 'Bearer k' });
  });

  it('Anthropic: x-api-key and the browser-access header', () => {
    const { url, headers } = anthropicListing('sk-ant-k');
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(headers).toEqual({
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-api-key': 'sk-ant-k',
    });
  });

  it('Google: x-goog-api-key', () => {
    const { url, headers } = googleListing('g-key');
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(headers).toEqual({ 'x-goog-api-key': 'g-key' });
  });
});

describe('resolveTransport', () => {
  it('a direct or local-cors endpoint gets the plain fetch back untouched', async () => {
    const fetchFn = vi.fn();
    const transport = await resolveTransport({ endpointId: 'lm-studio', companionUrl: DEFAULT_COMPANION_URL, origin: ORIGIN, fetch: fetchFn });
    expect(transport).toEqual({ ok: true, fetch: fetchFn });
  });

  it('a relay endpoint with the companion down: companion help, and no relay call made', async () => {
    const fetchFn = vi.fn();
    const probe = vi.fn().mockResolvedValue({ kind: 'unreachable' });
    const transport = await resolveTransport({ endpointId: 'nvidia', companionUrl: DEFAULT_COMPANION_URL, origin: ORIGIN, fetch: fetchFn, probe });
    expect(transport.ok).toBe(false);
    if (!transport.ok) {
      expect(transport.result.text).toContain('companion');
      expect(transport.result.help?.steps.join('\n')).toContain('pnpm companion');
    }
    expect(probe).toHaveBeenCalledWith(`${DEFAULT_COMPANION_URL}/health`, { fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a relay endpoint whose companion answers something other than 200 is still "down"', async () => {
    const probe = vi.fn().mockResolvedValue({ kind: 'answered', status: 500 });
    const transport = await resolveTransport({ endpointId: 'nvidia', companionUrl: DEFAULT_COMPANION_URL, origin: ORIGIN, probe });
    expect(transport.ok).toBe(false);
  });

  it('a relay endpoint with the companion up: the returned fetch goes through relayFetch', async () => {
    const relayCalls: unknown[] = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      relayCalls.push([input, init]);
      return new Response('ok');
    });
    const probe = vi.fn().mockResolvedValue({ kind: 'answered', status: 200 });
    const transport = await resolveTransport({ endpointId: 'nvidia', companionUrl: DEFAULT_COMPANION_URL, origin: ORIGIN, fetch: fetchFn, probe });
    expect(transport.ok).toBe(true);
    if (transport.ok) {
      await transport.fetch('https://integrate.api.nvidia.com/v1/models', { headers: { authorization: 'Bearer k' } });
    }
    const [url, init] = relayCalls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_COMPANION_URL}/relay`);
    expect(new Headers(init.headers).get(RELAY_TARGET_HEADER)).toBe('https://integrate.api.nvidia.com/v1/models');
  });
});

function chunkStream(chunks: readonly LlmStreamChunk[]): AsyncIterable<LlmStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe('runTestMessage', () => {
  it('text arrived: replied, with the elapsed seconds', async () => {
    let now = 1000;
    const clock = () => now;
    const stream = (async function* (): AsyncIterable<LlmStreamChunk> {
      yield { type: 'text-delta', text: 'ready' };
      now = 3300;
      yield { type: 'finish', reason: 'stop', usage: null };
    })();
    const result = await runTestMessage(stream, clock);
    expect(result).toEqual({ outcome: 'replied', text: 'ready', seconds: 2.3, message: 'Replied in 2.3 s' });
  });

  it('finish reason length with no text: the thinking-budget message', async () => {
    const stream = chunkStream([{ type: 'finish', reason: 'length', usage: null }]);
    const result = await runTestMessage(stream);
    expect(result.outcome).toBe('no-output');
    expect(result.message).toBe(
      'The model spent its whole output budget thinking and wrote nothing. Pick a non-thinking model, or one with a larger output limit.',
    );
  });

  it('reasoning deltas are not shown as the reply', async () => {
    const stream = chunkStream([
      { type: 'reasoning-delta', text: 'thinking...' },
      { type: 'finish', reason: 'length', usage: null },
    ]);
    const result = await runTestMessage(stream);
    expect(result.text).toBe('');
    expect(result.outcome).toBe('no-output');
  });

  it('finish reason error: the model reported an error', async () => {
    const stream = chunkStream([{ type: 'finish', reason: 'error', usage: null }]);
    const result = await runTestMessage(stream);
    expect(result).toMatchObject({ outcome: 'error', message: 'The model reported an error.' });
  });

  it('a thrown error: its own message', async () => {
    const stream: AsyncIterable<LlmStreamChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<LlmStreamChunk>> => Promise.reject(new Error('socket hang up')),
      }),
    };
    const result = await runTestMessage(stream);
    expect(result).toMatchObject({ outcome: 'error', message: 'socket hang up' });
  });
});
