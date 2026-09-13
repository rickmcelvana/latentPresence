import type { AudioChunk, CancellationSignal, SttResult } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { decodeWav } from '../tts/wav';
import { OpenAICompatibleSTTProvider } from './openai-compatible-stt';

/**
 * What is asserted here is the wire, because the wire is where this surface is easy to get
 * wrong in ways no type catches: a JSON body instead of multipart, `timestamp_granularities`
 * without its brackets, or plain `json` when word timings were wanted — each of which
 * produces a *successful* request that answers with less than was asked for.
 */

interface Capture {
  url: string;
  init: RequestInit;
  form: FormData;
}

function stubFetch(
  body: unknown,
  { status = 200, text = '' }: { status?: number; text?: string } = {},
): { fetch: typeof globalThis.fetch; calls: Capture[] } {
  const calls: Capture[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, form: init.body as FormData });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

async function* chunks(...parts: readonly AudioChunk[]): AsyncIterable<AudioChunk> {
  for (const part of parts) yield part;
}

/** A chunk of audible tone, so an empty-audio test is distinguishable from a quiet one. */
function chunk(samples: number, sampleRate = 16_000): AudioChunk {
  const data = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) data[i] = Math.sin(i / 8) * 0.5;
  return { samples: data, sampleRate, startMs: 0 };
}

/** The request headers, defaulted, so a missing capture fails the assertion not the test. */
function headersOf(capture: Capture | undefined): Record<string, string> {
  return (capture?.init.headers ?? {}) as Record<string, string>;
}

async function collect(results: AsyncIterable<SttResult>): Promise<SttResult[]> {
  const out: SttResult[] = [];
  for await (const item of results) out.push(item);
  return out;
}

function provider(fetch: typeof globalThis.fetch, overrides = {}) {
  return new OpenAICompatibleSTTProvider({
    id: 'stt',
    baseUrl: 'https://example.test/v1',
    model: 'whisper-1',
    fetch,
    ...overrides,
  });
}

describe('OpenAICompatibleSTTProvider', () => {
  it('posts multipart to /audio/transcriptions with the model and a wav file', async () => {
    const { fetch, calls } = stubFetch({ text: 'hello there' });
    await collect(provider(fetch).transcribe(chunks(chunk(1_600))));

    const call = calls[0];
    expect(call?.url).toBe('https://example.test/v1/audio/transcriptions');
    expect(call?.init.method).toBe('POST');
    expect(call?.form).toBeInstanceOf(FormData);
    expect(call?.form.get('model')).toBe('whisper-1');
    // Content-Type is deliberately absent: fetch adds it with the multipart boundary, and
    // setting it by hand produces a body no server can parse.
    expect(Object.keys((call?.init.headers ?? {}) as object)).not.toContain('content-type');

    const file = call?.form.get('file');
    expect(file).toBeInstanceOf(Blob);
    const decoded = decodeWav(new Uint8Array(await (file as Blob).arrayBuffer()));
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.samples).toHaveLength(1_600);
  });

  it('sends the microphone rate in the file rather than resampling', async () => {
    const { fetch, calls } = stubFetch({ text: 'x' });
    await collect(provider(fetch).transcribe(chunks(chunk(4_800, 48_000))));
    const file = calls[0]?.form.get('file') as Blob;
    // The server resamples. Doing it here would be a second lossy step for no gain.
    expect(decodeWav(new Uint8Array(await file.arrayBuffer())).sampleRate).toBe(48_000);
  });

  it('asks for plain json and no granularities when timings were not wanted', async () => {
    const { fetch, calls } = stubFetch({ text: 'hello' });
    await collect(provider(fetch).transcribe(chunks(chunk(1_600))));
    expect(calls[0]?.form.get('response_format')).toBe('json');
    expect(calls[0]?.form.get('timestamp_granularities[]')).toBeNull();
  });

  it('asks for verbose_json and bracketed granularities when they were', async () => {
    const { fetch, calls } = stubFetch({ text: 'hello', words: [] });
    await collect(
      provider(fetch, { wordTimestamps: true }).transcribe(chunks(chunk(1_600))),
    );
    // Both halves matter: `verbose_json` is the only format that carries words, and the
    // brackets are how the official client serialises the array.
    expect(calls[0]?.form.get('response_format')).toBe('verbose_json');
    expect(calls[0]?.form.get('timestamp_granularities[]')).toBe('word');
  });

  it('converts word times from seconds to milliseconds', async () => {
    const { fetch } = stubFetch({
      text: 'the afternoon light',
      language: 'english',
      words: [
        { word: 'the', start: 0, end: 0.24 },
        { word: 'afternoon', start: 0.24, end: 0.81 },
      ],
    });
    const [result] = await collect(
      provider(fetch, { wordTimestamps: true }).transcribe(chunks(chunk(1_600))),
    );
    expect(result?.words).toEqual([
      { text: 'the', startMs: 0, endMs: 240 },
      { text: 'afternoon', startMs: 240, endMs: 810 },
    ]);
    expect(result?.language).toBe('english');
  });

  it('drops a malformed word rather than emitting a NaN timing', async () => {
    const { fetch } = stubFetch({
      text: 'x',
      words: [{ word: 'ok', start: 0, end: 1 }, { word: 'bad', start: 'soon' }, null, 7],
    });
    const [result] = await collect(
      provider(fetch, { wordTimestamps: true }).transcribe(chunks(chunk(1_600))),
    );
    expect(result?.words).toEqual([{ text: 'ok', startMs: 0, endMs: 1_000 }]);
  });

  it('reports one final result and never a confidence it was not given', async () => {
    const { fetch } = stubFetch({ text: '  hello there  ' });
    const results = await collect(provider(fetch).transcribe(chunks(chunk(1_600))));
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe('hello there');
    expect(results[0]?.isFinal).toBe(true);
    expect(results[0]?.confidence).toBeNull();
  });

  it('sends a pinned language and then claims no detection', async () => {
    const { fetch, calls } = stubFetch({ text: 'x' });
    const configured = provider(fetch, { language: 'nb' });
    await collect(configured.transcribe(chunks(chunk(1_600))));
    expect(calls[0]?.form.get('language')).toBe('nb');
    expect((await configured.capabilities()).languageDetection).toBe(false);
    expect((await provider(fetch).capabilities()).languageDetection).toBe(true);
  });

  it('passes a vocabulary prompt through', async () => {
    const { fetch, calls } = stubFetch({ text: 'x' });
    await collect(provider(fetch, { prompt: 'latentPresence, VRM' }).transcribe(chunks(chunk(16))));
    expect(calls[0]?.form.get('prompt')).toBe('latentPresence, VRM');
  });

  it('sends no request at all for silence of zero length', async () => {
    const { fetch, calls } = stubFetch({ text: 'thanks for watching!' });
    // An empty file makes several servers answer with a hallucinated stock sentence, so
    // the request is worth not making.
    expect(await collect(provider(fetch).transcribe(chunks()))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('passes the server error through in its own words', async () => {
    const { fetch } = stubFetch(null, { status: 400, text: '{"error":"unknown model"}' });
    await expect(collect(provider(fetch).transcribe(chunks(chunk(1_600))))).rejects.toThrow(
      /stt: \/audio\/transcriptions returned 400 — \{"error":"unknown model"\}/u,
    );
  });

  it('yields nothing when cancelled before the request goes out', async () => {
    const { fetch, calls } = stubFetch({ text: 'x' });
    const signal: CancellationSignal = {
      aborted: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(await collect(provider(fetch).transcribe(chunks(chunk(1_600)), { signal }))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('does not set an authorization header when no key was configured', async () => {
    const { fetch, calls } = stubFetch({ text: 'x' });
    await collect(provider(fetch).transcribe(chunks(chunk(16))));
    expect(headersOf(calls[0])['authorization']).toBeUndefined();

    const keyed = stubFetch({ text: 'x' });
    await collect(provider(keyed.fetch, { apiKey: 'sk-test' }).transcribe(chunks(chunk(16))));
    expect(headersOf(keyed.calls[0])['authorization']).toBe('Bearer sk-test');
  });

  it('tolerates a trailing slash on the base url', async () => {
    const { fetch, calls } = stubFetch({ text: 'x' });
    await collect(
      provider(fetch, { baseUrl: 'https://example.test/v1//' }).transcribe(chunks(chunk(16))),
    );
    expect(calls[0]?.url).toBe('https://example.test/v1/audio/transcriptions');
  });

  it('reports what it was configured for, not what the endpoint might do', async () => {
    const { fetch } = stubFetch({ text: 'x' });
    expect(await provider(fetch).capabilities()).toEqual({
      streaming: false,
      wordTimestamps: false,
      languageDetection: true,
      runsInBrowser: false,
      languages: [],
    });
    expect((await provider(fetch, { wordTimestamps: true }).capabilities()).wordTimestamps).toBe(
      true,
    );
  });
});
