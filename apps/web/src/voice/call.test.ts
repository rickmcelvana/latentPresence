import { describe, expect, it, vi } from 'vitest';
import { ConversationMachine, attachHistory } from '@latentpresence/core';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import { FakeLLMProvider, FakeTTSProvider } from '@latentpresence/providers';
import type { AudioOutputHandle, CaptureHandle } from '@latentpresence/providers';
import type { LLMProvider, STTProvider, SttResult } from '@latentpresence/protocol';
import { VoiceCall, type JudgeLike, type VadLike } from './call';
import type { SpeechProviders } from './providers';

/**
 * The wiring a call is, with no audio graph and no models in it.
 *
 * What is worth asserting here is the part `/dev/voice` never had to decide: the order the
 * pieces are built in (a microphone that opens before Silero has loaded throws on its first
 * frame), and what is left running when one of them refuses. The loop itself — detector,
 * session, barge-in, the output queue — is measured elsewhere; this is the product's
 * plumbing.
 */

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function fakeAudio() {
  const closed: string[] = [];
  const handle = {
    output: {
      enqueue: () => 1,
      duck: () => undefined,
      unduck: () => undefined,
      fadeOut: () => Promise.resolve(),
      position: () => ({ frame: 0, at: 0 }),
      subscribe: () => () => undefined,
      record: () => undefined,
    },
    context: { sampleRate: 24_000, outputLatency: 0, currentTime: 0 },
    node: {},
    close: async () => {
      closed.push('audio');
    },
  } as unknown as AudioOutputHandle;
  return { handle, closed };
}

function fakeVad(overrides: Partial<VadLike> = {}) {
  const terminated: string[] = [];
  const port: VadLike = {
    load: async () => undefined,
    push: () => undefined,
    onFrame: () => () => undefined,
    onError: () => () => undefined,
    terminate: () => {
      terminated.push('vad');
    },
    ...overrides,
  };
  return { port, terminated };
}

function fakeJudge() {
  const terminated: string[] = [];
  const port: JudgeLike = {
    load: async () => undefined,
    judge: async () => 0.95,
    terminate: () => {
      terminated.push('judge');
    },
  };
  return { port, terminated };
}

/** Recognition that never produces a turn: every test here stops short of a spoken turn. */
async function* nothingHeard(): AsyncGenerator<SttResult> {
  // Nothing is yielded, so no `require-yield` suppression is needed and no turn ends.
}

function speech(): SpeechProviders & { disposed: string[] } {
  const disposed: string[] = [];
  const stt: STTProvider = {
    id: 'fake-stt',
    capabilities: async () => ({
      streaming: false,
      wordTimestamps: false,
      languageDetection: false,
      // False on purpose: `warmRecognition` transcribes a second of silence for a browser
      // recogniser, and there is nothing here to warm.
      runsInBrowser: false,
      languages: ['en'],
    }),
    transcribe: () => nothingHeard(),
  };
  return {
    tts: new FakeTTSProvider('fake-tts', { msPerChar: 1 }),
    stt,
    dispose: () => {
      disposed.push('speech');
    },
    disposed,
  };
}

function llm(): LLMProvider {
  return new FakeLLMProvider('fake-llm', {
    script: [{ type: 'text-delta', text: 'Hello.' }, { type: 'finish', reason: 'stop', usage: null }],
  });
}

function baseOptions() {
  const machine = new ConversationMachine({ sessionId: 'chat', characterId: 'alice' });
  machine.start();
  const { history } = attachHistory(machine, { system: null });
  return { machine, history };
}

function mic(): CaptureHandle {
  return { deviceLabel: 'Test microphone', context: {}, stop: async () => undefined } as unknown as CaptureHandle;
}

describe('VoiceCall — the order it builds in', () => {
  it('loads the turn models before it opens the microphone', async () => {
    // A frame pushed before `vad.load()` resolves is refused, not queued, so a microphone
    // opened first would lose the opening word of every conversation.
    const { machine, history } = baseOptions();
    const order: string[] = [];
    const audio = fakeAudio();
    const vad = fakeVad({
      load: async () => {
        order.push('vad.load');
      },
    });
    const judge = fakeJudge();
    const providers = speech();

    const call = await VoiceCall.start({
      machine,
      history,
      llm: llm(),
      modelId: 'test',
      temperature: null,
      speech: providers,
      consent: new ModelConsent(memoryStorage()),
      voiceId: 'af_heart',
      speed: 1,
      backchannels: false,
      createAudio: async () => {
        order.push('audio');
        return audio.handle;
      },
      createVad: () => vad.port,
      createJudge: () => {
        order.push('judge');
        return judge.port;
      },
      capture: async () => {
        order.push('capture');
        return mic();
      },
    });

    expect(order.indexOf('vad.load')).toBeLessThan(order.indexOf('capture'));
    expect(order).toContain('judge');
    expect(call.inputLabel).toBe('Test microphone');
    await call.stop();
  });

  it('synthesises nothing but the warm-up word when backchannels are off', async () => {
    // `prepareBackchannels` speaks four phrases through the voice, so "off" has to mean no
    // synthesis at all — otherwise the switch only hides them.
    const { machine, history } = baseOptions();
    const audio = fakeAudio();
    const vad = fakeVad();
    const judge = fakeJudge();
    const providers = speech();
    const synthesize = vi.spyOn(providers.tts, 'synthesize');

    const call = await VoiceCall.start({
      machine,
      history,
      llm: llm(),
      modelId: 'test',
      temperature: null,
      speech: providers,
      consent: new ModelConsent(memoryStorage()),
      voiceId: 'af_heart',
      speed: 1,
      backchannels: false,
      createAudio: async () => audio.handle,
      createVad: () => vad.port,
      createJudge: () => judge.port,
      capture: async () => mic(),
    });

    expect(synthesize).toHaveBeenCalledTimes(1);
    await call.stop();
  });
});

describe('VoiceCall — what it leaves behind when something refuses', () => {
  it('closes everything when the microphone is refused', async () => {
    const { machine, history } = baseOptions();
    const audio = fakeAudio();
    const vad = fakeVad();
    const judge = fakeJudge();
    const providers = speech();

    await expect(
      VoiceCall.start({
        machine,
        history,
        llm: llm(),
        modelId: 'test',
        temperature: null,
        speech: providers,
        consent: new ModelConsent(memoryStorage()),
        voiceId: 'af_heart',
        speed: 1,
        backchannels: false,
        createAudio: async () => audio.handle,
        createVad: () => vad.port,
        createJudge: () => judge.port,
        capture: async () => {
          throw new Error('NotAllowedError');
        },
      }),
    ).rejects.toThrow('NotAllowedError');

    expect(vad.terminated).toEqual(['vad']);
    expect(judge.terminated).toEqual(['judge']);
    expect(providers.disposed).toEqual(['speech']);
    expect(audio.closed).toEqual(['audio']);
  });

  it('closes everything when a model will not load, and never opens the microphone', async () => {
    const { machine, history } = baseOptions();
    const audio = fakeAudio();
    const vad = fakeVad({ load: async () => Promise.reject(new Error('no WebGPU adapter')) });
    const judge = fakeJudge();
    const providers = speech();
    let captured = false;

    await expect(
      VoiceCall.start({
        machine,
        history,
        llm: llm(),
        modelId: 'test',
        temperature: null,
        speech: providers,
        consent: new ModelConsent(memoryStorage()),
        voiceId: 'af_heart',
        speed: 1,
        backchannels: false,
        createAudio: async () => audio.handle,
        createVad: () => vad.port,
        createJudge: () => judge.port,
        capture: async () => {
          captured = true;
          return mic();
        },
      }),
    ).rejects.toThrow('no WebGPU adapter');

    expect(captured).toBe(false);
    expect(vad.terminated).toEqual(['vad']);
    expect(judge.terminated).toEqual(['judge']);
    expect(providers.disposed).toEqual(['speech']);
    expect(audio.closed).toEqual(['audio']);
  });
});

describe('VoiceCall — stopping', () => {
  it('ends once, however many times it is asked, and releases every provider', async () => {
    const { machine, history } = baseOptions();
    const audio = fakeAudio();
    const vad = fakeVad();
    const judge = fakeJudge();
    const providers = speech();
    const stops: string[] = [];

    const call = await VoiceCall.start({
      machine,
      history,
      llm: llm(),
      modelId: 'test',
      temperature: null,
      speech: providers,
      consent: new ModelConsent(memoryStorage()),
      voiceId: 'af_heart',
      speed: 1,
      backchannels: false,
      createAudio: async () => audio.handle,
      createVad: () => vad.port,
      createJudge: () => judge.port,
      capture: async () =>
        ({
          deviceLabel: 'mic',
          context: {},
          stop: async () => {
            stops.push('capture');
          },
        }) as unknown as CaptureHandle,
    });

    await call.stop();
    await call.stop();

    expect(stops).toEqual(['capture']);
    expect(vad.terminated).toEqual(['vad']);
    expect(judge.terminated).toEqual(['judge']);
    expect(providers.disposed).toEqual(['speech']);
    expect(audio.closed).toEqual(['audio']);
  });
});
