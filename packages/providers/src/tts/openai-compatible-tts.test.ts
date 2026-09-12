import type { TtsRequest } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import type { HttpFetch } from '../llm/discovery';
import { describeHint, OpenAICompatibleTTSProvider } from './openai-compatible-tts';

/** A 16-bit mono WAV, built by hand so the test owns every byte of what the server
 * "returned". Sixteen samples is enough to prove the rate and the decode. */
function wav(sampleRate: number, values: readonly number[]): Uint8Array {
  const data = values.length * 2;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, data, true);
  values.forEach((value, index) => view.setInt16(44 + index * 2, value, true));
  return out;
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A transport that records what it was asked for and answers from a routing table. */
function fakeFetch(routes: Record<string, () => Response>): HttpFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const path = Object.keys(routes).find((key) => url.endsWith(key));
    const route = path === undefined ? undefined : routes[path];
    if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(route());
  };
  return Object.assign(fetchFn, { calls });
}

function request(overrides: Partial<TtsRequest> = {}): TtsRequest {
  return { text: 'Hello there.', voiceId: 'af_heart', speed: 1, hint: null, ...overrides };
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;
}

async function first(provider: OpenAICompatibleTTSProvider, req = request()) {
  for await (const chunk of provider.synthesize(req)) return chunk;
  throw new Error('no chunk');
}

function providerFor(
  fetchFn: HttpFetch & { calls: Call[] },
  config: Partial<{ hintStyle: 'none' | 'instructions'; baseUrl: string; apiKey: string }> = {},
): OpenAICompatibleTTSProvider {
  return new OpenAICompatibleTTSProvider({
    id: 'server',
    baseUrl: config.baseUrl ?? 'http://localhost:8880/v1',
    model: 'kokoro',
    fetch: fetchFn,
    ...(config.hintStyle === undefined ? {} : { hintStyle: config.hintStyle }),
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
  });
}

/** A 200 carrying audio bytes, as the endpoint answers. */
function speech(bytes: Uint8Array): () => Response {
  return () => new Response(bytes as unknown as BodyInit, { status: 200 });
}

describe('OpenAICompatibleTTSProvider capabilities', () => {
  it('does not claim to stream, because it does not', async () => {
    const provider = new OpenAICompatibleTTSProvider({
      id: 'server',
      baseUrl: 'http://localhost:8880/v1',
      model: 'kokoro',
    });
    const capabilities = await provider.capabilities();
    expect(capabilities.streaming).toBe(false);
    expect(capabilities.wordTimestamps).toBe(false);
    expect(capabilities.runsInBrowser).toBe(false);
    expect(capabilities.sampleRate).toBe(24_000);
  });

  it('reports emotionHints only when instructions are switched on', async () => {
    const base = { id: 's', baseUrl: 'http://x/v1', model: 'gpt-4o-mini-tts' } as const;
    expect((await new OpenAICompatibleTTSProvider(base).capabilities()).emotionHints).toBe(false);
    expect(
      (await new OpenAICompatibleTTSProvider({ ...base, hintStyle: 'instructions' }).capabilities())
        .emotionHints,
    ).toBe(true);
  });

  it('promises the configured rate', async () => {
    const provider = new OpenAICompatibleTTSProvider({
      id: 's',
      baseUrl: 'http://x/v1',
      model: 'tts-1',
      sampleRate: 22_050,
    });
    expect((await provider.capabilities()).sampleRate).toBe(22_050);
  });
});

describe('OpenAICompatibleTTSProvider listVoices', () => {
  it('reads the object shape Kokoro-FastAPI returns by default', async () => {
    const fetchFn = fakeFetch({
      '/audio/voices': () =>
        Response.json({
          voices: [
            { id: 'af_heart', name: 'af_heart', overall_grade: 'A' },
            { id: 'bm_fable', name: 'bm_fable' },
          ],
        }),
    });
    const provider = new OpenAICompatibleTTSProvider({
      id: 's',
      baseUrl: 'http://localhost:8880/v1',
      model: 'kokoro',
      fetch: fetchFn,
    });
    const voices = await provider.listVoices();
    expect(voices.map((voice) => voice.id)).toEqual(['af_heart', 'bm_fable']);
    expect(voices[0]?.language).toBeNull();
    expect(voices[0]?.gender).toBe('unknown');
  });

  it('reads the plain-string shape of ?legacy=true', async () => {
    const fetchFn = fakeFetch({
      '/audio/voices': () => Response.json({ voices: ['af_heart', 'am_puck'] }),
    });
    const provider = new OpenAICompatibleTTSProvider({
      id: 's',
      baseUrl: 'http://x/v1',
      model: 'kokoro',
      fetch: fetchFn,
    });
    expect((await provider.listVoices()).map((voice) => voice.label)).toEqual([
      'af_heart',
      'am_puck',
    ]);
  });

  it('falls back to the configured list when there is no listing endpoint — OpenAI', async () => {
    const configured = [
      { id: 'alloy', label: 'Alloy', language: null, gender: 'unknown' as const },
    ];
    const provider = new OpenAICompatibleTTSProvider({
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voices: configured,
      fetch: fakeFetch({}),
    });
    expect(await provider.listVoices()).toEqual(configured);
  });

  it('falls back when the transport throws outright', async () => {
    const provider = new OpenAICompatibleTTSProvider({
      id: 's',
      baseUrl: 'http://x/v1',
      model: 'kokoro',
      voices: [{ id: 'a', label: 'A', language: null, gender: 'unknown' }],
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(await provider.listVoices()).toHaveLength(1);
  });

  it('falls back when the body is not the shape it claims', async () => {
    const provider = new OpenAICompatibleTTSProvider({
      id: 's',
      baseUrl: 'http://x/v1',
      model: 'kokoro',
      voices: [{ id: 'a', label: 'A', language: null, gender: 'unknown' }],
      fetch: fakeFetch({ '/audio/voices': () => Response.json({ voices: 'all of them' }) }),
    });
    expect(await provider.listVoices()).toHaveLength(1);
  });

  it('drops entries with no usable id rather than listing a blank voice', async () => {
    const provider = new OpenAICompatibleTTSProvider({
      id: 's',
      baseUrl: 'http://x/v1',
      model: 'kokoro',
      fetch: fakeFetch({
        '/audio/voices': () => Response.json({ voices: ['', { name: 'no id' }, 'af_sky'] }),
      }),
    });
    expect((await provider.listVoices()).map((voice) => voice.id)).toEqual(['af_sky']);
  });

  it('returns an empty list when there is nothing configured and nothing served', async () => {
    const provider = new OpenAICompatibleTTSProvider({
      id: 's',
      baseUrl: 'http://x/v1',
      model: 'kokoro',
      fetch: fakeFetch({}),
    });
    expect(await provider.listVoices()).toEqual([]);
  });
});

describe('OpenAICompatibleTTSProvider synthesize', () => {
  it('posts the verified body to /audio/speech', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0, 16_384])) });
    await first(providerFor(fetchFn));

    const call = fetchFn.calls[0];
    expect(call?.url).toBe('http://localhost:8880/v1/audio/speech');
    expect(call?.init?.method).toBe('POST');
    expect(bodyOf(call)).toEqual({
      model: 'kokoro',
      input: 'Hello there.',
      voice: 'af_heart',
      response_format: 'wav',
      speed: 1,
    });
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0])) });
    await first(providerFor(fetchFn, { baseUrl: 'http://localhost:8880/v1/' }));
    expect(fetchFn.calls[0]?.url).toBe('http://localhost:8880/v1/audio/speech');
  });

  it('sends the key as a bearer token when there is one', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0])) });
    await first(providerFor(fetchFn, { apiKey: 'sk-test' }));
    const headers = fetchFn.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers['content-type']).toBe('application/json');
  });

  it('clamps speed into the documented 0.25–4 range', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0])) });
    const provider = providerFor(fetchFn);
    await first(provider, request({ speed: 9 }));
    await first(provider, request({ speed: 0.1 }));
    expect(bodyOf(fetchFn.calls[0])['speed']).toBe(4);
    expect(bodyOf(fetchFn.calls[1])['speed']).toBe(0.25);
  });

  it('sends no instructions unless asked to', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0])) });
    await first(
      providerFor(fetchFn),
      request({ hint: { label: 'joy', intensity: 0.9, energy: 0.9 } }),
    );
    expect(bodyOf(fetchFn.calls[0])).not.toHaveProperty('instructions');
  });

  it('renders the hint into instructions when configured to', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0])) });
    await first(
      providerFor(fetchFn, { hintStyle: 'instructions' }),
      request({ hint: { label: 'joy', intensity: 0.9, energy: 0.9 } }),
    );
    expect(bodyOf(fetchFn.calls[0])['instructions']).toBe('Tone: joy, strong. Energy: high.');
  });

  it('sends no instructions for a null hint even when configured', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0])) });
    await first(providerFor(fetchFn, { hintStyle: 'instructions' }));
    expect(bodyOf(fetchFn.calls[0])).not.toHaveProperty('instructions');
  });

  it('decodes the audio and marks it final', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0, 16_384, -16_384])) });
    const chunk = await first(providerFor(fetchFn));
    expect([...chunk.samples]).toEqual([0, 0.5, -0.5]);
    expect(chunk.isFinal).toBe(true);
    expect(chunk.startMs).toBe(0);
  });

  it('takes the rate from the header, not from the configuration', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(16_000, [0])) });
    const provider = new OpenAICompatibleTTSProvider({
      id: 'server',
      baseUrl: 'http://x/v1',
      model: 'kokoro',
      sampleRate: 24_000,
      fetch: fetchFn,
    });
    expect((await first(provider)).sampleRate).toBe(16_000);
  });

  it('reads headerless pcm at the configured rate', async () => {
    const pcm = new Uint8Array(4);
    new DataView(pcm.buffer).setInt16(2, 16_384, true);
    const fetchFn = fakeFetch({ '/audio/speech': speech(pcm) });
    const provider = new OpenAICompatibleTTSProvider({
      id: 'server',
      baseUrl: 'http://x/v1',
      model: 'kokoro',
      responseFormat: 'pcm',
      sampleRate: 22_050,
      fetch: fetchFn,
    });
    const chunk = await first(provider);
    expect(bodyOf(fetchFn.calls[0])['response_format']).toBe('pcm');
    expect(chunk.sampleRate).toBe(22_050);
    expect([...chunk.samples]).toEqual([0, 0.5]);
  });

  it('throws with the status and the server’s own words when it fails', async () => {
    const fetchFn = fakeFetch({
      '/audio/speech': () => new Response('voice not found', { status: 400 }),
    });
    await expect(first(providerFor(fetchFn))).rejects.toThrow(
      /server: \/audio\/speech returned 400 — voice not found/,
    );
  });

  it('passes an abort signal to the transport, for barge-in', async () => {
    const fetchFn = fakeFetch({ '/audio/speech': speech(wav(24_000, [0])) });
    await first(providerFor(fetchFn));
    expect(fetchFn.calls[0]?.init?.signal).toBeDefined();
  });
});

describe('describeHint', () => {
  it('bands intensity and energy into words the model can use', () => {
    expect(describeHint({ label: 'joy', intensity: 0.1, energy: 0.1 })).toBe(
      'Tone: joy, slight. Energy: low.',
    );
    expect(describeHint({ label: 'concern', intensity: 0.5, energy: 0.5 })).toBe(
      'Tone: concern, clear. Energy: moderate.',
    );
    expect(describeHint({ label: 'pride', intensity: 1, energy: 1 })).toBe(
      'Tone: pride, strong. Energy: high.',
    );
  });

  it('stays short — it shares a 4096-character budget with the text', () => {
    const described = describeHint({ label: 'embarrassment', intensity: 1, energy: 0 });
    expect(described).toBe('Tone: embarrassment, strong. Energy: low.');
    expect(described.length).toBeLessThan(80);
  });
});
