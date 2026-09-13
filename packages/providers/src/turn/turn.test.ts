import { TurnDetector, type TurnEvent } from '@latentpresence/core';
import type {
  AsrRequest,
  AsrResponse,
  AsrWorkerPort,
  SmartTurnRequest,
  SmartTurnResponse,
  SmartTurnWorkerPort,
  VadRequest,
  VadResponse,
  VadWorkerPort,
} from '@latentpresence/ml-web';
import { TURN_WINDOW_SAMPLES } from '@latentpresence/ml-web';
import type { CancellationSignal, STTProvider, SttResult } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { BrowserSTTProvider } from '../stt/browser-stt';
import { FakeSTTProvider } from '../stt/fake';
import { BrowserSileroVad } from './browser-vad';
import { SmartTurnJudge } from './smart-turn-judge';
import { speculativeTranscription } from './speculative';

/** A port that records what was posted and lets the test answer by hand. */
class ManualPort<Request, Response> {
  readonly sent: { message: Request; transfer: readonly Transferable[] }[] = [];
  terminated = false;
  private readonly listeners = new Set<(message: Response) => void>();
  /** Called on every post, for fakes that answer some requests themselves. */
  onPost: ((message: Request) => void) | null = null;

  post(message: Request, transfer: readonly Transferable[] = []): void {
    this.sent.push({ message, transfer });
    this.onPost?.(message);
  }

  onMessage(listener: (message: Response) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: Response): void {
    for (const listener of Array.from(this.listeners)) listener(message);
  }

  ofType<T extends Request extends { type: infer K } ? K : never>(type: T): Extract<Request, { type: T }>[] {
    return this.sent
      .map((entry) => entry.message)
      .filter((message): message is Extract<Request, { type: T }> => (message as { type: unknown }).type === type);
  }
}

type SmartTurnPort = ManualPort<SmartTurnRequest, SmartTurnResponse> & SmartTurnWorkerPort;
type VadPort = ManualPort<VadRequest, VadResponse> & VadWorkerPort;
type AsrPort = ManualPort<AsrRequest, AsrResponse> & AsrWorkerPort;

function smartTurnPort(autoReady = true): SmartTurnPort {
  const port = new ManualPort<SmartTurnRequest, SmartTurnResponse>();
  port.onPost = (message) => {
    if (message.type === 'load' && autoReady) {
      port.emit({ type: 'ready', loadMs: 5, build: message.build, backend: message.backend });
    }
  };
  return port;
}

function signal(): { signal: CancellationSignal; abort: () => void } {
  const listeners = new Set<() => void>();
  const value = {
    aborted: false,
    addEventListener: (_type: 'abort', listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: 'abort', listener: () => void) => listeners.delete(listener),
  };
  return {
    signal: value,
    abort: () => {
      value.aborted = true;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('SmartTurnJudge', () => {
  it('defaults to the fp32 build on WebGPU (ADR-21)', async () => {
    const port = smartTurnPort();
    const judge = new SmartTurnJudge({ createWorker: () => port });
    await judge.load();
    expect(port.ofType('load')).toEqual([{ type: 'load', build: 'gpu', backend: 'webgpu' }]);
  });

  it('refuses int8 on WebGPU at construction, before any worker exists', () => {
    let created = false;
    const make = (): SmartTurnPort => {
      created = true;
      return smartTurnPort();
    };
    expect(() => new SmartTurnJudge({ createWorker: make, build: 'cpu', backend: 'webgpu' })).toThrow(/int8.*WebGPU/u);
    expect(created).toBe(false);
    expect(() => new SmartTurnJudge({ createWorker: make, build: 'cpu', backend: 'wasm' })).not.toThrow();
  });

  it('sends only the last 8 s, as a copy, and resolves with the probability', async () => {
    const port = smartTurnPort();
    const measured: number[] = [];
    const judge = new SmartTurnJudge({ createWorker: () => port, onMeasured: (m) => measured.push(m.inferenceMs) });
    const audio = Float32Array.from({ length: TURN_WINDOW_SAMPLES + 100 }, (_, i) => i);

    const answer = judge.judge(audio, signal().signal);
    await tick();
    const [request] = port.ofType('judge');
    expect(request?.samples.length).toBe(TURN_WINDOW_SAMPLES);
    expect(request?.samples[0]).toBe(100);
    // The caller's buffer is untouched and still whole: recognition holds the same one.
    expect(audio.length).toBe(TURN_WINDOW_SAMPLES + 100);
    expect(port.sent.at(-1)?.transfer).toEqual([request?.samples.buffer]);
    expect(port.sent.at(-1)?.transfer).not.toContain(audio.buffer);

    port.emit({ type: 'probability', requestId: request?.requestId ?? -1, probability: 0.91, featuresMs: 22, inferenceMs: 14 });
    await expect(answer).resolves.toBe(0.91);
    expect(measured).toEqual([14]);
  });

  it('passes a cancellation to the worker and rejects when it is acknowledged', async () => {
    const port = smartTurnPort();
    const judge = new SmartTurnJudge({ createWorker: () => port });
    const { signal: s, abort } = signal();
    const answer = judge.judge(new Float32Array(16_000), s);
    await tick();
    abort();
    const [cancel] = port.ofType('cancel');
    expect(cancel?.requestId).toBe(port.ofType('judge')[0]?.requestId);
    port.emit({ type: 'cancelled', requestId: cancel?.requestId ?? -1 });
    await expect(answer).rejects.toThrow(/cancelled/u);
  });

  it('does not reach the worker at all for an already-cancelled signal', async () => {
    const port = smartTurnPort();
    const judge = new SmartTurnJudge({ createWorker: () => port });
    const { signal: s, abort } = signal();
    abort();
    await expect(judge.judge(new Float32Array(16_000), s)).rejects.toThrow(/cancelled/u);
    expect(port.ofType('judge')).toEqual([]);
  });

  it('matches answers to requests, whatever order they return in', async () => {
    const port = smartTurnPort();
    const judge = new SmartTurnJudge({ createWorker: () => port });
    const first = judge.judge(new Float32Array(16_000), signal().signal);
    const second = judge.judge(new Float32Array(16_000), signal().signal);
    await tick();
    const [a, b] = port.ofType('judge');
    port.emit({ type: 'probability', requestId: b?.requestId ?? -1, probability: 0.2, featuresMs: 1, inferenceMs: 1 });
    port.emit({ type: 'probability', requestId: a?.requestId ?? -1, probability: 0.8, featuresMs: 1, inferenceMs: 1 });
    await expect(first).resolves.toBe(0.8);
    await expect(second).resolves.toBe(0.2);
  });

  it('rejects a request the worker failed on, and everything outstanding on a worker failure', async () => {
    const port = smartTurnPort();
    const judge = new SmartTurnJudge({ createWorker: () => port });
    const first = judge.judge(new Float32Array(16_000), signal().signal);
    const second = judge.judge(new Float32Array(16_000), signal().signal);
    await tick();
    const [a] = port.ofType('judge');
    port.emit({ type: 'error', requestId: a?.requestId ?? -1, message: 'feature block is not a log-mel' });
    await expect(first).rejects.toThrow(/log-mel/u);
    port.emit({ type: 'error', requestId: null, message: 'device lost' });
    await expect(second).rejects.toThrow(/device lost/u);
  });

  it('loads once for concurrent callers, and can retry a failed load', async () => {
    const port = smartTurnPort(false);
    let created = 0;
    const judge = new SmartTurnJudge({
      createWorker: () => {
        created += 1;
        return port;
      },
    });
    const one = judge.load();
    const two = judge.load();
    expect(port.ofType('load')).toHaveLength(1);
    port.emit({ type: 'error', requestId: null, message: 'consent declined' });
    await expect(one).rejects.toThrow(/consent declined/u);
    await expect(two).rejects.toThrow(/consent declined/u);

    const three = judge.load();
    expect(port.ofType('load')).toHaveLength(2);
    port.emit({ type: 'ready', loadMs: 1, build: 'gpu', backend: 'webgpu' });
    await expect(three).resolves.toBeUndefined();
    expect(created).toBe(1);
  });
});

describe('BrowserSileroVad', () => {
  function vadPort(): VadPort {
    const port = new ManualPort<VadRequest, VadResponse>();
    port.onPost = (message) => {
      if (message.type === 'load') port.emit({ type: 'ready', loadMs: 3 });
    };
    return port;
  }

  it('refuses frames before load and frames of the wrong length', async () => {
    const vad = new BrowserSileroVad({ createWorker: vadPort });
    expect(() => vad.push(new Float32Array(512), 0)).toThrow(/before load/u);
    await vad.load();
    expect(() => vad.push(new Float32Array(480), 0)).toThrow(/512 samples/u);
  });

  it('transfers each frame and delivers the worker’s answers as VadFrames, in order', async () => {
    const port = vadPort();
    const vad = new BrowserSileroVad({ createWorker: () => port });
    await vad.load();
    const seen: number[] = [];
    vad.onFrame((frame) => seen.push(frame.at));

    const samples = new Float32Array(512);
    vad.push(samples, 32);
    expect(port.sent.at(-1)?.transfer).toEqual([samples.buffer]);

    port.emit({ type: 'probability', samples: new Float32Array(512), probability: 0.1, at: 32 });
    port.emit({ type: 'probability', samples: new Float32Array(512), probability: 0.9, at: 64 });
    expect(seen).toEqual([32, 64]);
  });

  it('reports a frame failure without ending the stream', async () => {
    const port = vadPort();
    const vad = new BrowserSileroVad({ createWorker: () => port });
    await vad.load();
    const errors: string[] = [];
    vad.onError((error) => errors.push(error.message));
    port.emit({ type: 'error', message: 'wasm exception' });
    expect(errors).toEqual(['silero-vad: wasm exception']);
  });
});

describe('speculativeTranscription', () => {
  it('starts recognition when called, not when the result is read — the overlap depends on it', async () => {
    let started = 0;
    const stt: STTProvider = {
      id: 'probe',
      capabilities: () => new FakeSTTProvider().capabilities(),
      async *transcribe() {
        started += 1;
        yield { text: 'hello', isFinal: true, confidence: null, language: null, words: [] } satisfies SttResult;
      },
    };
    const recognise = speculativeTranscription(stt);
    const running = recognise({ samples: new Float32Array(160), sampleRate: 16_000, startMs: 0 }, signal().signal);
    // Nobody has awaited `running`. A bare generator would still read 0 here.
    await tick();
    expect(started).toBe(1);
    await expect(running).resolves.toMatchObject({ text: 'hello' });
  });

  it('resolves null, not a rejection, for a cancelled candidate', async () => {
    const { signal: s, abort } = signal();
    const recognise = speculativeTranscription(new FakeSTTProvider('fake-stt', { transcript: 'hello there' }));
    abort();
    await expect(recognise({ samples: new Float32Array(160), sampleRate: 16_000, startMs: 0 }, s)).resolves.toBeNull();
  });
});

/**
 * The done-when's second clause, end to end with every real driver and only the workers
 * faked: when a candidate window is cut, the recognition worker and the Smart Turn worker
 * both receive it before either has answered anything.
 */
describe('ADR-21 overlap, through the real drivers', () => {
  it('posts the candidate to recognition and to Smart Turn together, and keeps the transcript when the turn ends', async () => {
    const vadWorker = new ManualPort<VadRequest, VadResponse>() as VadPort;
    vadWorker.onPost = (message) => {
      if (message.type === 'load') vadWorker.emit({ type: 'ready', loadMs: 1 });
    };
    const turnWorker = smartTurnPort();
    const asrWorker = new ManualPort<AsrRequest, AsrResponse>() as AsrPort;
    asrWorker.onPost = (message) => {
      if (message.type === 'load') asrWorker.emit({ type: 'ready', loadMs: 1 });
    };

    const vad = new BrowserSileroVad({ createWorker: () => vadWorker });
    const judge = new SmartTurnJudge({ createWorker: () => turnWorker });
    const stt = new BrowserSTTProvider({ id: 'moonshine', model: 'moonshine-tiny', createWorker: () => asrWorker });
    await Promise.all([vad.load(), judge.load()]);

    let clock = 0;
    const detector = new TurnDetector({ now: () => clock, judge, recognise: speculativeTranscription(stt) });
    const events: TurnEvent<Promise<SttResult | null>>[] = [];
    detector.subscribe((event) => events.push(event));
    vad.onFrame((frame) => detector.push(frame));

    // The worker's answers, as Silero would give them: 10 frames of speech, then silence.
    const answer = (probability: number): void => {
      vadWorker.emit({ type: 'probability', samples: new Float32Array(512).fill(0.1), probability, at: clock });
      clock += 32;
    };
    for (let i = 0; i < 10; i += 1) answer(0.95);
    for (let i = 0; i < 4; i += 1) answer(0.02);

    expect(events.map((event) => event.type)).toEqual(['speech-start', 'candidate']);
    // Let the drivers' own load awaits run, then look at both workers before answering either.
    for (let i = 0; i < 5; i += 1) await tick();
    const [judgeRequest] = turnWorker.ofType('judge');
    const [asrRequest] = asrWorker.ofType('transcribe');
    expect(judgeRequest).toBeDefined();
    expect(asrRequest).toBeDefined();
    // Same audio to both: 14 frames of it, the judge's copy cut from the recogniser's.
    expect(asrRequest?.samples.length).toBe(14 * 512);
    expect(judgeRequest?.samples.length).toBe(14 * 512);
    expect(asrRequest?.sampleRate).toBe(16_000);

    // The judge answers first — 40 ms against recognition's 180 — and ends the turn.
    turnWorker.emit({ type: 'probability', requestId: judgeRequest?.requestId ?? -1, probability: 0.88, featuresMs: 22, inferenceMs: 14 });
    await tick();
    const end = events.find((event): event is Extract<typeof event, { type: 'turn-end' }> => event.type === 'turn-end');
    expect(end?.reason).toBe('model');
    // No cancel went to recognition: the turn ended on the very audio it was already reading.
    expect(asrWorker.ofType('cancel')).toEqual([]);

    asrWorker.emit({ type: 'result', requestId: asrRequest?.requestId ?? -1, text: 'the afternoon light', words: [], language: null });
    await expect(end?.recognition).resolves.toMatchObject({ text: 'the afternoon light' });
  });

  it('cancels the speculative recognition in the worker when speech resumes', async () => {
    const asrWorker = new ManualPort<AsrRequest, AsrResponse>() as AsrPort;
    asrWorker.onPost = (message) => {
      if (message.type === 'load') asrWorker.emit({ type: 'ready', loadMs: 1 });
      if (message.type === 'cancel') asrWorker.emit({ type: 'cancelled', requestId: message.requestId });
    };
    const stt = new BrowserSTTProvider({ id: 'moonshine', model: 'moonshine-tiny', createWorker: () => asrWorker });

    let clock = 0;
    const recognitions: Promise<SttResult | null>[] = [];
    const recognise = speculativeTranscription(stt);
    const detector = new TurnDetector<Promise<SttResult | null>>({
      now: () => clock,
      recognise: (audio, s) => {
        const running = recognise(audio, s);
        recognitions.push(running);
        return running;
      },
    });
    const push = (probability: number): void => {
      detector.push({ samples: new Float32Array(512), probability, at: clock });
      clock += 32;
    };
    for (let i = 0; i < 10; i += 1) push(0.95);
    for (let i = 0; i < 4; i += 1) push(0.02);
    for (let i = 0; i < 5; i += 1) await tick();
    expect(asrWorker.ofType('transcribe')).toHaveLength(1);

    push(0.9); // they carry on talking
    await tick();
    expect(asrWorker.ofType('cancel')).toHaveLength(1);
    await expect(recognitions[0]).resolves.toBeNull();
  });
});
