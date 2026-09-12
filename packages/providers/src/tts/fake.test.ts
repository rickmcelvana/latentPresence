import type { CancellationSignal, SpokenAudioChunk, TtsRequest } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeTTSProvider } from './fake';

function request(overrides: Partial<TtsRequest> = {}): TtsRequest {
  return { text: 'Hello there, friend.', voiceId: 'fake-neutral', speed: 1, hint: null, ...overrides };
}

async function collect(stream: AsyncIterable<SpokenAudioChunk>): Promise<SpokenAudioChunk[]> {
  const chunks: SpokenAudioChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function totalSamples(chunks: readonly SpokenAudioChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.samples.length, 0);
}

/** An already-aborted structural signal — enough to prove the fake stops. */
const ABORTED: CancellationSignal = {
  aborted: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

describe('FakeTTSProvider', () => {
  it('claims every capability by default, so a consumer meets every branch', async () => {
    const capabilities = await new FakeTTSProvider('fake').capabilities();
    expect(capabilities.streaming).toBe(true);
    expect(capabilities.wordTimestamps).toBe(true);
    expect(capabilities.emotionHints).toBe(true);
  });

  it('lets a test say it cannot do something', async () => {
    const provider = new FakeTTSProvider('fake', { capabilities: { wordTimestamps: false } });
    const capabilities = await provider.capabilities();
    expect(capabilities.wordTimestamps).toBe(false);
    expect(capabilities.streaming).toBe(true);
  });

  it('lists voices, including one of each gender the schema allows', async () => {
    const voices = await new FakeTTSProvider('fake').listVoices();
    expect(voices.map((voice) => voice.gender)).toEqual(['neutral', 'female']);
  });

  it('records every request it was given', async () => {
    const provider = new FakeTTSProvider('fake');
    await collect(provider.synthesize(request({ text: 'One.' })));
    await collect(provider.synthesize(request({ text: 'Two.' })));
    expect(provider.requests.map((entry) => entry.text)).toEqual(['One.', 'Two.']);
  });

  it('produces audio whose duration tracks the text', async () => {
    const provider = new FakeTTSProvider('fake', { msPerChar: 10 });
    const short = await collect(provider.synthesize(request({ text: 'Hi.' })));
    const long = await collect(provider.synthesize(request({ text: 'Hi there, friend.' })));
    expect(totalSamples(long)).toBeGreaterThan(totalSamples(short));
  });

  it('speaks faster when asked to', async () => {
    const provider = new FakeTTSProvider('fake', { msPerChar: 10 });
    const normal = await collect(provider.synthesize(request()));
    const quick = await collect(provider.synthesize(request({ speed: 2 })));
    expect(quick[0]?.samples.length).toBeLessThan(normal[0]?.samples.length ?? 0);
  });

  it('splits into the requested number of chunks, with startMs adding up', async () => {
    const provider = new FakeTTSProvider('fake', { chunks: 4, msPerChar: 10 });
    const chunks = await collect(provider.synthesize(request()));

    expect(chunks).toHaveLength(4);
    let expected = 0;
    for (const chunk of chunks) {
      expect(chunk.startMs).toBeCloseTo(expected, 6);
      expected += (chunk.samples.length / chunk.sampleRate) * 1000;
    }
  });

  it('marks exactly one chunk final, and it is the last', async () => {
    const chunks = await collect(
      new FakeTTSProvider('fake', { chunks: 3 }).synthesize(request()),
    );
    expect(chunks.filter((chunk) => chunk.isFinal)).toHaveLength(1);
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it('puts word timings on the final chunk, covering the whole utterance', async () => {
    const chunks = await collect(
      new FakeTTSProvider('fake', { chunks: 2, msPerChar: 10 }).synthesize(
        request({ text: 'one two three' }),
      ),
    );
    const words = chunks.at(-1)?.words;
    expect(words?.map((word) => word.text)).toEqual(['one', 'two', 'three']);
    expect(words?.[0]?.startMs).toBe(0);
    expect(chunks[0]?.words).toBeUndefined();
  });

  it('replays a script verbatim when given one', async () => {
    const script: SpokenAudioChunk[] = [
      { samples: new Float32Array(8), sampleRate: 16_000, startMs: 0, isFinal: false },
      { samples: new Float32Array(4), sampleRate: 16_000, startMs: 1, isFinal: true },
    ];
    expect(await collect(new FakeTTSProvider('fake', { script }).synthesize(request()))).toEqual(
      script,
    );
  });

  it('stops on an aborted signal, still releasing the queue', async () => {
    const chunks = await collect(
      new FakeTTSProvider('fake', { chunks: 5 }).synthesize(request(), { signal: ABORTED }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.isFinal).toBe(true);
  });

  it('says something even for a single character', async () => {
    const chunks = await collect(new FakeTTSProvider('fake').synthesize(request({ text: '.' })));
    expect(chunks[0]?.samples.length).toBeGreaterThan(0);
  });
});
