import { describe, expect, it, vi } from 'vitest';
import { llmPresets } from '../llm/presets';
import { browserAccess, corsHelp, ollamaAllowsByDefault } from './browser-access';
import { probeEndpoint } from './probe';
import { DEFAULT_COMPANION_URL, RELAY_TARGET_HEADER, relayFetch } from './relay';

describe('browserAccess (measured 2026-09-14)', () => {
  it('has a measured answer for every preset and both native adapters', () => {
    const expected: Record<string, string> = {
      ollama: 'local-cors',
      'lm-studio': 'local-cors',
      vllm: 'direct',
      'llama-cpp': 'direct',
      openrouter: 'direct',
      nvidia: 'relay',
      deepseek: 'direct',
      kimi: 'direct',
      anthropic: 'direct',
      google: 'direct',
    };
    for (const preset of llmPresets) expect(browserAccess(preset.id), preset.id).toBe(expected[preset.id]);
    expect(browserAccess('anthropic')).toBe('direct');
    expect(browserAccess('google')).toBe('direct');
  });

  it('treats an unmeasured custom endpoint as direct, for the probe to correct', () => {
    expect(browserAccess('my-own-server')).toBe('direct');
  });
});

describe('corsHelp', () => {
  it('has nothing to say about Ollama from a local origin, which it allows by default', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://localhost', 'http://0.0.0.0:3000']) {
      expect(ollamaAllowsByDefault(origin), origin).toBe(true);
      expect(corsHelp('ollama', origin)).toBeNull();
    }
  });

  it('names the exact origin to add to OLLAMA_ORIGINS for any other page', () => {
    for (const origin of ['https://app.latentpresence.com', 'http://tauri.localhost', 'http://192.168.1.20:5173']) {
      expect(ollamaAllowsByDefault(origin), origin).toBe(false);
      const help = corsHelp('ollama', origin);
      expect(help?.steps[0]).toBe(`Set the environment variable OLLAMA_ORIGINS to ${origin}`);
      expect(help?.steps.join('\n')).toContain('Windows');
    }
  });

  it('says how to turn CORS on in LM Studio, both ways', () => {
    const help = corsHelp('lm-studio', 'http://localhost:5173');
    expect(help?.steps.join('\n')).toContain('Enable CORS');
    expect(help?.steps.join('\n')).toContain('lms server start --cors');
  });

  it('sends NVIDIA users to the companion', () => {
    expect(corsHelp('nvidia', 'http://localhost:5173')?.steps.join('\n')).toContain('pnpm companion');
  });

  it('has nothing to say for a cloud endpoint that allows every origin', () => {
    for (const id of ['openrouter', 'deepseek', 'kimi', 'anthropic', 'google', 'custom']) {
      expect(corsHelp(id, 'http://localhost:5173'), id).toBeNull();
    }
  });
});

const failed = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));
const timedOut = (): Promise<Response> => Promise.reject(new DOMException('signal timed out', 'TimeoutError'));

describe('probeEndpoint', () => {
  it('reports a readable answer with its status, 401 included, and makes one request', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('', { status: 401 }));
    expect(await probeEndpoint('http://x/v1/models', { fetch: fetchFn, headers: { authorization: 'Bearer k' } })).toEqual({
      kind: 'answered',
      status: 401,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer k' } });
  });

  it('calls a refusal that an opaque request gets past cors-blocked', async () => {
    const fetchFn = vi.fn((_url: string | URL, init?: RequestInit) =>
      init?.mode === 'no-cors' ? Promise.resolve(new Response(null, { status: 200 })) : failed(),
    );
    expect(await probeEndpoint('http://x', { fetch: fetchFn })).toEqual({ kind: 'cors-blocked' });
    // The opaque request cannot carry the key: a no-cors request drops such headers anyway.
    expect(fetchFn.mock.calls[1]?.[1]).not.toHaveProperty('headers');
  });

  it('calls it unreachable when the opaque request fails too', async () => {
    expect(await probeEndpoint('http://x', { fetch: vi.fn(failed) })).toEqual({ kind: 'unreachable' });
  });

  it('reports a timeout on either request, and does not retry a timed-out readable one', async () => {
    const first = vi.fn(timedOut);
    expect(await probeEndpoint('http://x', { fetch: first })).toEqual({ kind: 'timeout' });
    expect(first).toHaveBeenCalledTimes(1);
    const second = vi.fn((_url: string | URL, init?: RequestInit) => (init?.mode === 'no-cors' ? timedOut() : failed()));
    expect(await probeEndpoint('http://x', { fetch: second })).toEqual({ kind: 'timeout' });
  });

  it('never throws, and gives every request a deadline', async () => {
    const fetchFn = vi.fn(failed);
    await probeEndpoint('http://x', { fetch: fetchFn, timeoutMs: 10 });
    for (const call of fetchFn.mock.calls as unknown as [string, RequestInit][]) expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('relayFetch', () => {
  it('sends the request to the companion with the real URL in a header, all else unchanged', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));
    const controller = new AbortController();
    await relayFetch('http://127.0.0.1:9999/', fetchFn)('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
      signal: controller.signal,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/relay');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get(RELAY_TARGET_HEADER)).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(headers.get('authorization')).toBe('Bearer k');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('accepts a URL object and a Headers instance, and defaults to the companion port', async () => {
    const fetchFn = vi.fn(async () => new Response('ok'));
    await relayFetch(undefined, fetchFn)(new URL('https://integrate.api.nvidia.com/v1/models'), {
      headers: new Headers({ authorization: 'Bearer k' }),
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_COMPANION_URL}/relay`);
    expect(new Headers(init.headers).get(RELAY_TARGET_HEADER)).toBe('https://integrate.api.nvidia.com/v1/models');
  });
});
