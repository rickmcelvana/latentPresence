import type { KokoroRequest, KokoroResponse, KokoroWorkerPort } from '@latentpresence/ml-web';
import type { CancellationSignal, SpokenAudioChunk, TtsRequest } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { KokoroBrowserTTSProvider } from './kokoro-browser';

/**
 * A worker that never loads a model.
 *
 * This is the whole reason `KokoroBrowserConfig` takes a factory and a structural port:
 * the conversation with the worker — request ids, the held-back final chunk, cancellation,
 * a failed load — is logic, and logic that can only be exercised with a GPU and 325 MB of
 * weights is logic nobody exercises.
 */
type ScriptPart<T = KokoroResponse> = T extends unknown ? Omit<T, 'requestId'> : never;

class FakePort implements KokoroWorkerPort {
  readonly sent: KokoroRequest[] = [];
  terminated = false;
  /** Emitted in order when a `speak` arrives. `requestId` is filled in from the request. */
  speakScript: ScriptPart[] | null = null;
  /** When false, `load` is not answered — for testing a load that never succeeds. */
  autoReady = true;
  private readonly listeners = new Set<(message: KokoroResponse) => void>();

  post(message: KokoroRequest): void {
    this.sent.push(message);
    if (message.type === 'load' && this.autoReady) this.emit({ type: 'ready', loadMs: 12 });
    if (message.type === 'speak' && this.speakScript !== null) {
      for (const part of this.speakScript) {
        this.emit({ ...part, requestId: message.requestId } as KokoroResponse);
      }
    }
  }

  onMessage(listener: (message: KokoroResponse) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: KokoroResponse): void {
    for (const listener of this.listeners) listener(message);
  }
}

function audio(samples: number, sampleRate = 24_000): ScriptPart {
  return { type: 'audio', index: 0, samples: new Float32Array(samples), sampleRate, text: 'x' };
}

const DONE: ScriptPart = { type: 'done' };

function request(overrides: Partial<TtsRequest> = {}): TtsRequest {
  return { text: 'Hello there.', voiceId: 'af_heart', speed: 1, hint: null, ...overrides };
}

function providerWith(port: FakePort): KokoroBrowserTTSProvider {
  return new KokoroBrowserTTSProvider({ id: 'kokoro', createWorker: () => port });
}

async function collect(stream: AsyncIterable<SpokenAudioChunk>): Promise<SpokenAudioChunk[]> {
  const chunks: SpokenAudioChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/**
 * Let everything pending run.
 *
 * A test that emits a worker message by hand has to wait for the generator to have
 * *asked* for one, and the generator gets there through the load promise — several
 * microtask turns, not one. A macrotask drains all of them; `await Promise.resolve()`
 * drains exactly one and hangs the test.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A mutable stand-in for the structural `CancellationSignal`, which is all the protocol
 * asks for — no DOM `AbortSignal` needed. */
function makeSignal(): { signal: CancellationSignal; abort: () => void } {
  const listeners = new Set<() => void>();
  const state = {
    aborted: false,
    addEventListener: (_type: 'abort', listener: () => void): void => void listeners.add(listener),
    removeEventListener: (_type: 'abort', listener: () => void): void =>
      void listeners.delete(listener),
  };
  return {
    signal: state,
    abort: (): void => {
      state.aborted = true;
      for (const listener of listeners) listener();
    },
  };
}

describe('KokoroBrowserTTSProvider capabilities', () => {
  it('promises Kokoro’s own 24 kHz', async () => {
    const capabilities = await providerWith(new FakePort()).capabilities();
    expect(capabilities.sampleRate).toBe(24_000);
    expect(capabilities.runsInBrowser).toBe(true);
    expect(capabilities.streaming).toBe(true);
  });

  it('admits it cannot take an emotion hint', async () => {
    const capabilities = await providerWith(new FakePort()).capabilities();
    expect(capabilities.emotionHints).toBe(false);
    expect(capabilities.styleTags).toBe(false);
  });

  it('admits it has no word timings, which is what sends P2 to lip-sync analysis', async () => {
    expect((await providerWith(new FakePort()).capabilities()).wordTimestamps).toBe(false);
  });
});

describe('KokoroBrowserTTSProvider listVoices', () => {
  it('lists the built-in table without loading anything', async () => {
    const port = new FakePort();
    const voices = await providerWith(port).listVoices();
    expect(voices).toHaveLength(28);
    expect(voices.map((voice) => voice.id)).toContain('af_heart');
    expect(port.sent).toHaveLength(0);
  });
});

describe('KokoroBrowserTTSProvider synthesize', () => {
  it('loads once, on the first request, with the measured defaults', async () => {
    const port = new FakePort();
    port.speakScript = [audio(240), DONE];
    const provider = providerWith(port);
    await collect(provider.synthesize(request()));
    await collect(provider.synthesize(request()));

    const loads = port.sent.filter((message) => message.type === 'load');
    expect(loads).toEqual([{ type: 'load', device: 'webgpu', dtype: 'fp32' }]);
  });

  it('passes the voice and speed through', async () => {
    const port = new FakePort();
    port.speakScript = [audio(240), DONE];
    await collect(providerWith(port).synthesize(request({ voiceId: 'bm_fable', speed: 1.25 })));

    const speak = port.sent.find((message) => message.type === 'speak');
    expect(speak).toMatchObject({ text: 'Hello there.', voice: 'bm_fable', speed: 1.25 });
  });

  it('marks exactly the last chunk final', async () => {
    const port = new FakePort();
    port.speakScript = [audio(240), audio(480), audio(120), DONE];
    const chunks = await collect(providerWith(port).synthesize(request()));

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.isFinal)).toEqual([false, false, true]);
  });

  it('runs startMs forward by the duration of what came before', async () => {
    const port = new FakePort();
    // 240 samples at 24 kHz is 10 ms; 2400 is 100 ms.
    port.speakScript = [audio(240), audio(2400), audio(240), DONE];
    const chunks = await collect(providerWith(port).synthesize(request()));

    expect(chunks.map((chunk) => chunk.startMs)).toEqual([0, 10, 110]);
  });

  it('still yields a final chunk when the worker produced no audio', async () => {
    const port = new FakePort();
    port.speakScript = [DONE];
    const chunks = await collect(providerWith(port).synthesize(request()));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.isFinal).toBe(true);
    expect(chunks[0]?.samples).toHaveLength(0);
  });

  it('carries the rate the worker reported, not the one we assumed', async () => {
    const port = new FakePort();
    port.speakScript = [audio(240, 22_050), DONE];
    const chunks = await collect(providerWith(port).synthesize(request()));
    expect(chunks[0]?.sampleRate).toBe(22_050);
  });

  it('gives each request its own id, so two never cross', async () => {
    const port = new FakePort();
    port.speakScript = [audio(240), DONE];
    const provider = providerWith(port);
    await collect(provider.synthesize(request()));
    await collect(provider.synthesize(request()));

    const ids = port.sent
      .filter((message) => message.type === 'speak')
      .map((message) => (message.type === 'speak' ? message.requestId : -1));
    expect(new Set(ids).size).toBe(2);
  });

  it('ignores audio belonging to another request', async () => {
    const port = new FakePort();
    const provider = providerWith(port);
    const chunks = collect(provider.synthesize(request()));
    await flush();

    port.emit({ ...audio(9600), requestId: 99 } as KokoroResponse);
    port.emit({ ...audio(240), requestId: 0 } as KokoroResponse);
    port.emit({ type: 'done', requestId: 0 });

    expect((await chunks).map((chunk) => chunk.samples.length)).toEqual([240]);
  });

  it('turns a worker error into a thrown error naming the provider', async () => {
    const port = new FakePort();
    port.speakScript = [{ type: 'error', message: 'ONNX Runtime wasm exception' }];
    await expect(collect(providerWith(port).synthesize(request()))).rejects.toThrow(
      /kokoro: ONNX Runtime wasm exception/,
    );
  });
});

describe('KokoroBrowserTTSProvider cancellation', () => {
  it('tells the worker to stop when the signal aborts', async () => {
    const port = new FakePort();
    const control = makeSignal();
    const provider = providerWith(port);
    const chunks = collect(provider.synthesize(request(), { signal: control.signal }));
    await flush();

    port.emit({ ...audio(240), requestId: 0 } as KokoroResponse);
    control.abort();
    port.emit({ type: 'done', requestId: 0 });
    await chunks;

    expect(port.sent).toContainEqual({ type: 'cancel', requestId: 0 });
  });

  it('cancels immediately for a signal that was already aborted', async () => {
    const port = new FakePort();
    port.speakScript = [DONE];
    const control = makeSignal();
    control.abort();
    await collect(providerWith(port).synthesize(request(), { signal: control.signal }));

    expect(port.sent).toContainEqual({ type: 'cancel', requestId: 0 });
  });

  it('still releases the queue with a final chunk after a cancel', async () => {
    const port = new FakePort();
    const control = makeSignal();
    const chunks = collect(providerWith(port).synthesize(request(), { signal: control.signal }));
    await flush();

    port.emit({ ...audio(240), requestId: 0 } as KokoroResponse);
    control.abort();
    port.emit({ type: 'done', requestId: 0 });

    const collected = await chunks;
    expect(collected.at(-1)?.isFinal).toBe(true);
  });
});

describe('KokoroBrowserTTSProvider lifecycle', () => {
  it('does not spawn a worker until something asks for audio', () => {
    let built = 0;
    const provider = new KokoroBrowserTTSProvider({
      id: 'kokoro',
      createWorker: () => {
        built += 1;
        return new FakePort();
      },
    });
    expect(provider.id).toBe('kokoro');
    expect(built).toBe(0);
  });

  it('rejects when the worker fails to load, and lets the next call try again', async () => {
    const port = new FakePort();
    port.autoReady = false;
    const provider = providerWith(port);

    const first = collect(provider.synthesize(request()));
    await flush();
    port.emit({ type: 'error', requestId: null, message: 'no WebGPU adapter' });
    await expect(first).rejects.toThrow(/no WebGPU adapter/);

    port.autoReady = true;
    port.speakScript = [audio(240), DONE];
    expect(await collect(provider.synthesize(request()))).toHaveLength(1);
  });

  it('terminates the worker and builds a new one next time', async () => {
    const ports: FakePort[] = [];
    const provider = new KokoroBrowserTTSProvider({
      id: 'kokoro',
      createWorker: () => {
        const port = new FakePort();
        port.speakScript = [audio(240), DONE];
        ports.push(port);
        return port;
      },
    });

    await collect(provider.synthesize(request()));
    provider.terminate();
    await collect(provider.synthesize(request()));

    expect(ports).toHaveLength(2);
    expect(ports[0]?.terminated).toBe(true);
  });
});
