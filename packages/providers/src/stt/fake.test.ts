import type { AudioChunk, CancellationSignal, SttResult } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeSTTProvider } from './fake';

async function* chunks(...parts: readonly AudioChunk[]): AsyncIterable<AudioChunk> {
  for (const part of parts) yield part;
}

function chunk(samples: number, sampleRate = 16_000): AudioChunk {
  return { samples: new Float32Array(samples).fill(0.25), sampleRate, startMs: 0 };
}

async function collect(results: AsyncIterable<SttResult>): Promise<SttResult[]> {
  const out: SttResult[] = [];
  for await (const item of results) out.push(item);
  return out;
}

/** A signal that aborts after `after` results have been pulled. */
function signalAfter(after: number): { signal: CancellationSignal; tick: () => void } {
  let seen = 0;
  const signal = {
    aborted: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return {
    signal,
    tick: () => {
      seen += 1;
      if (seen >= after) signal.aborted = true;
    },
  };
}

describe('FakeSTTProvider', () => {
  it('reports the most capable shape by default', async () => {
    // Deliberately the most capable: a consumer written against this fake is exercised on
    // every branch a real provider can take, rather than only the ones Moonshine has.
    expect(await new FakeSTTProvider().capabilities()).toEqual({
      streaming: true,
      wordTimestamps: true,
      languageDetection: true,
      runsInBrowser: true,
      languages: ['en'],
    });
  });

  it('lets capabilities be narrowed to imitate a specific provider', async () => {
    const provider = new FakeSTTProvider('m', {
      capabilities: { streaming: false, wordTimestamps: false },
    });
    const capabilities = await provider.capabilities();
    expect(capabilities.streaming).toBe(false);
    expect(capabilities.languageDetection).toBe(true);
  });

  it('emits partials word by word and then one final', async () => {
    const results = await collect(
      new FakeSTTProvider('f', { transcript: 'one two three' }).transcribe(chunks(chunk(16))),
    );
    expect(results.map((result) => result.text)).toEqual([
      'one',
      'one two',
      'one two three',
      'one two three',
    ]);
    expect(results.filter((result) => result.isFinal)).toHaveLength(1);
    expect(results[results.length - 1]?.isFinal).toBe(true);
  });

  it('produces word timings that add up', async () => {
    const results = await collect(
      new FakeSTTProvider('f', { transcript: 'one two' }).transcribe(chunks(chunk(16))),
    );
    expect(results[results.length - 1]?.words).toEqual([
      { text: 'one', startMs: 0, endMs: 300 },
      { text: 'two', startMs: 300, endMs: 600 },
    ]);
  });

  it('records the audio it was given, joined, at its rate', async () => {
    const provider = new FakeSTTProvider();
    await collect(provider.transcribe(chunks(chunk(160, 48_000), chunk(80, 48_000))));
    expect(provider.heard).toHaveLength(1);
    expect(provider.heard[0]?.samples).toHaveLength(240);
    // The rate is what catches a silent resampling bug upstream — the audio arriving is
    // never the question, the rate it arrived at is.
    expect(provider.heard[0]?.sampleRate).toBe(48_000);
  });

  it('yields nothing and counts the call when cancelled up front', async () => {
    const provider = new FakeSTTProvider();
    const signal: CancellationSignal = {
      aborted: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(await collect(provider.transcribe(chunks(chunk(16)), { signal }))).toEqual([]);
    // "No result" and "never ran" are different failures and a test needs to tell them
    // apart; the counter is what makes that possible.
    expect(provider.cancelledCalls).toBe(1);
    expect(provider.heard).toHaveLength(1);
  });

  it('stops mid-transcription when cancelled between results', async () => {
    const provider = new FakeSTTProvider('f', { transcript: 'one two three four' });
    const { signal, tick } = signalAfter(2);
    const results: SttResult[] = [];
    for await (const result of provider.transcribe(chunks(chunk(16)), { signal })) {
      results.push(result);
      tick();
    }
    // The path ADR-21 takes on every candidate window that turns out not to be a turn.
    expect(results).toHaveLength(2);
    expect(results.some((result) => result.isFinal)).toBe(false);
    expect(provider.cancelledCalls).toBe(1);
  });

  it('replays a script when one is given', async () => {
    const script: SttResult[] = [
      { text: 'scripted', isFinal: true, confidence: 0.5, language: 'nb', words: [] },
    ];
    expect(await collect(new FakeSTTProvider('f', { script }).transcribe(chunks(chunk(16))))).toEqual(
      script,
    );
  });

  it('reports a null confidence by default, like both real providers', async () => {
    const results = await collect(new FakeSTTProvider().transcribe(chunks(chunk(16))));
    expect(results[0]?.confidence).toBeNull();
    const scored = await collect(
      new FakeSTTProvider('f', { confidence: 0.9 }).transcribe(chunks(chunk(16))),
    );
    expect(scored[0]?.confidence).toBe(0.9);
  });
});
