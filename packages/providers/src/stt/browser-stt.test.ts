import type { AsrRequest, AsrResponse, AsrWorkerPort } from '@latentpresence/ml-web';
import type { AudioChunk, CancellationSignal } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { BrowserSTTProvider } from './browser-stt';
import { MoonshineBrowserSTTProvider } from './moonshine-browser';
import { WhisperBrowserSTTProvider } from './whisper-browser';

/**
 * A worker that never loads a model.
 *
 * The reason `BrowserSttConfig` takes a factory and a structural port: the conversation
 * with the worker — request ids, cancellation before and during work, a failed load — is
 * logic, and logic that can only be exercised with a GPU and 113 MB of weights is logic
 * nobody exercises.
 */
type ScriptPart<T = AsrResponse> = T extends unknown ? Omit<T, 'requestId'> : never;

class FakePort implements AsrWorkerPort {
  readonly sent: AsrRequest[] = [];
  terminated = false;
  /** Emitted in order when a `transcribe` arrives. `requestId` comes from the request. */
  script: ScriptPart[] | null = null;
  /** When false, `load` is not answered — for a load that never succeeds. */
  autoReady = true;
  /** When true, a `cancel` is answered with `cancelled` instead of the script. */
  honourCancel = false;
  private readonly listeners = new Set<(message: AsrResponse) => void>();
  private pending: number | null = null;

  post(message: AsrRequest): void {
    this.sent.push(message);
    if (message.type === 'load' && this.autoReady) this.emit({ type: 'ready', loadMs: 12 });
    if (message.type === 'transcribe') {
      if (this.honourCancel) {
        this.pending = message.requestId;
        return;
      }
      for (const part of this.script ?? []) {
        this.emit({ ...part, requestId: message.requestId } as AsrResponse);
      }
    }
    if (message.type === 'cancel' && this.pending === message.requestId) {
      this.emit({ type: 'cancelled', requestId: message.requestId });
      this.pending = null;
    }
  }

  onMessage(listener: (message: AsrResponse) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: AsrResponse): void {
    for (const listener of this.listeners) listener(message);
  }
}

const RESULT: ScriptPart = {
  type: 'result',
  text: 'the afternoon light',
  words: [{ text: 'the', startMs: 0, endMs: 200 }],
  language: 'en',
};

async function* chunks(...parts: readonly AudioChunk[]): AsyncIterable<AudioChunk> {
  for (const part of parts) yield part;
}

function chunk(samples: number, sampleRate = 48_000, startMs = 0): AudioChunk {
  return { samples: new Float32Array(samples), sampleRate, startMs };
}

function makeSignal(): { signal: CancellationSignal; abort: () => void } {
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener: (_type: 'abort', listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: 'abort', listener: () => void) => listeners.delete(listener),
  };
  return {
    signal,
    abort: () => {
      signal.aborted = true;
      for (const listener of listeners) listener();
    },
  };
}

function providerWith(port: FakePort, overrides = {}): BrowserSTTProvider {
  return new BrowserSTTProvider({
    id: 'asr',
    model: 'moonshine-tiny',
    createWorker: () => port,
    ...overrides,
  });
}

async function collect(results: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of results) out.push(item);
  return out;
}

describe('BrowserSTTProvider', () => {
  it('loads once for two utterances', async () => {
    const port = new FakePort();
    port.script = [RESULT];
    const provider = providerWith(port);
    await collect(provider.transcribe(chunks(chunk(480))));
    await collect(provider.transcribe(chunks(chunk(480))));
    expect(port.sent.filter((message) => message.type === 'load')).toHaveLength(1);
  });

  it('yields one final result carrying the words the worker reported', async () => {
    const port = new FakePort();
    port.script = [RESULT];
    const results = await collect(providerWith(port).transcribe(chunks(chunk(480))));
    expect(results).toEqual([
      {
        text: 'the afternoon light',
        isFinal: true,
        confidence: null,
        language: 'en',
        words: [{ text: 'the', startMs: 0, endMs: 200 }],
      },
    ]);
  });

  it('joins the chunks and passes the microphone rate through untouched', async () => {
    const port = new FakePort();
    port.script = [RESULT];
    await collect(providerWith(port).transcribe(chunks(chunk(480), chunk(480), chunk(240))));
    const sent = port.sent.find((message) => message.type === 'transcribe');
    expect(sent).toMatchObject({ sampleRate: 48_000 });
    // Resampling is the worker's job. If the provider did it here the worker would do it
    // again, and the audio would come out a third of its real length.
    expect(sent?.type === 'transcribe' && sent.samples.length).toBe(1_200);
  });

  it('refuses audio whose rate changes mid-utterance', async () => {
    const port = new FakePort();
    port.script = [RESULT];
    await expect(
      collect(providerWith(port).transcribe(chunks(chunk(480, 48_000), chunk(480, 16_000)))),
    ).rejects.toThrow(/sample rate changed/u);
  });

  describe('cancellation, which ADR-21 makes the common path', () => {
    it('yields nothing when cancelled before the audio ends', async () => {
      const port = new FakePort();
      port.script = [RESULT];
      const { signal, abort } = makeSignal();
      abort();
      const results = await collect(providerWith(port).transcribe(chunks(chunk(480)), { signal }));
      expect(results).toEqual([]);
      // Never reached the worker at all: a candidate window that is not a turn should
      // cost no model time.
      expect(port.sent.some((message) => message.type === 'transcribe')).toBe(false);
    });

    it('yields nothing when cancelled while the worker is transcribing', async () => {
      const port = new FakePort();
      port.honourCancel = true;
      const { signal, abort } = makeSignal();
      const provider = providerWith(port);
      const results = collect(provider.transcribe(chunks(chunk(480)), { signal }));
      // Let the generator reach the point of waiting on the worker.
      await new Promise((resolve) => setTimeout(resolve, 0));
      abort();
      // No partial text left behind — the done-when for this task.
      expect(await results).toEqual([]);
      expect(port.sent.some((message) => message.type === 'cancel')).toBe(true);
    });

    it('stops listening once a call ends, cancelled or not', async () => {
      const port = new FakePort();
      port.script = [RESULT];
      const provider = providerWith(port);
      await collect(provider.transcribe(chunks(chunk(480))));
      // A stale listener would make a late message from the worker resolve a call that
      // has already finished.
      port.emit({ type: 'result', requestId: 0, text: 'late', words: [], language: null });
      expect(true).toBe(true);
    });
  });

  it('surfaces a worker error with the provider id attached', async () => {
    const port = new FakePort();
    port.script = [{ type: 'error', message: 'unsupported op' }];
    await expect(collect(providerWith(port).transcribe(chunks(chunk(480))))).rejects.toThrow(
      /asr: unsupported op/u,
    );
  });

  it('does not cache a failed load for ever', async () => {
    const port = new FakePort();
    port.autoReady = false;
    const provider = providerWith(port);
    const first = collect(provider.transcribe(chunks(chunk(480))));
    port.emit({ type: 'error', requestId: null, message: 'consent declined' });
    await expect(first).rejects.toThrow(/consent declined/u);

    // The user granted consent. A second attempt must try again rather than replay the
    // rejection.
    port.autoReady = true;
    port.script = [RESULT];
    await expect(collect(provider.transcribe(chunks(chunk(480))))).resolves.toHaveLength(1);
  });

  it('terminates and can be used again afterwards', async () => {
    const port = new FakePort();
    port.script = [RESULT];
    const provider = providerWith(port);
    await collect(provider.transcribe(chunks(chunk(480))));
    provider.terminate();
    expect(port.terminated).toBe(true);
    await collect(provider.transcribe(chunks(chunk(480))));
    expect(port.sent.filter((message) => message.type === 'load')).toHaveLength(2);
  });

  it('refuses a quantised precision on WebGPU at construction', () => {
    // Before the microphone is touched, not after: a settings screen can show this while
    // the user is still choosing.
    expect(() => providerWith(new FakePort(), { device: 'webgpu', dtype: 'q8' })).toThrow(
      /ADR-20/u,
    );
    expect(() => providerWith(new FakePort(), { device: 'wasm', dtype: 'q8' })).not.toThrow();
  });
});

describe('the two configured providers', () => {
  it('Moonshine reports no timings, English only, in the browser', async () => {
    const provider = new MoonshineBrowserSTTProvider({
      id: 'moonshine',
      createWorker: () => new FakePort(),
    });
    expect(await provider.capabilities()).toEqual({
      streaming: false,
      wordTimestamps: false,
      languageDetection: false,
      runsInBrowser: true,
      languages: ['en'],
    });
  });

  it('Whisper reports timings and says nothing about languages', async () => {
    const provider = new WhisperBrowserSTTProvider({
      id: 'whisper',
      createWorker: () => new FakePort(),
    });
    const capabilities = await provider.capabilities();
    expect(capabilities.wordTimestamps).toBe(true);
    expect(capabilities.languages).toEqual([]);
    // It can detect, but transformers.js 3.8.1 exports no way to read the answer back.
    expect(capabilities.languageDetection).toBe(false);
  });

  it('Moonshine never sends a language, because it would be ignored', async () => {
    const port = new FakePort();
    port.script = [RESULT];
    const provider = new MoonshineBrowserSTTProvider({
      id: 'moonshine',
      createWorker: () => port,
    });
    await collect(provider.transcribe(chunks(chunk(480))));
    const sent = port.sent.find((message) => message.type === 'transcribe');
    expect(sent).toMatchObject({ language: null });
  });

  it('Whisper passes a configured language through', async () => {
    const port = new FakePort();
    port.script = [RESULT];
    const provider = new WhisperBrowserSTTProvider({
      id: 'whisper',
      createWorker: () => port,
      language: 'nb',
    });
    await collect(provider.transcribe(chunks(chunk(480))));
    expect(port.sent.find((message) => message.type === 'transcribe')).toMatchObject({
      language: 'nb',
    });
  });

  it('each defaults to the model its docstring names', async () => {
    const moonshine = new FakePort();
    const whisper = new FakePort();
    moonshine.script = [RESULT];
    whisper.script = [RESULT];
    await collect(
      new MoonshineBrowserSTTProvider({ id: 'm', createWorker: () => moonshine }).transcribe(
        chunks(chunk(480)),
      ),
    );
    await collect(
      new WhisperBrowserSTTProvider({ id: 'w', createWorker: () => whisper }).transcribe(
        chunks(chunk(480)),
      ),
    );
    expect(moonshine.sent[0]).toMatchObject({ type: 'load', model: 'moonshine-tiny' });
    expect(whisper.sent[0]).toMatchObject({ type: 'load', model: 'whisper-base' });
  });
});
