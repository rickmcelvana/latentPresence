import { describe, expect, it } from 'vitest';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import { FakeTTSProvider } from '@latentpresence/providers';
import type { AudioOutputHandle } from '@latentpresence/providers';
import type { TtsRequest } from '@latentpresence/protocol';
import type { SettingsDeps } from '../settings/deps';
import { WARM_TEXT } from './call';
import { Speaker } from './speaker';

/** The speaker's plumbing (P2-T08): what it builds, in what order, and what it leaves behind. */

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

function fakeAudio(log: string[]) {
  return {
    output: {
      enqueue: () => 7,
      duck: () => undefined,
      unduck: () => undefined,
      fadeOut: () => Promise.resolve(),
      position: () => null,
      subscribe: () => () => undefined,
    },
    context: {},
    node: {},
    close: async () => {
      log.push('audio closed');
    },
  } as unknown as AudioOutputHandle;
}

/** A voice that records what it was asked to say and whether it was stopped. */
function recordingTts(log: string[], fail = false) {
  const inner = new FakeTTSProvider('fake-tts', { msPerChar: 1 });
  const said: TtsRequest[] = [];
  const tts = Object.assign(Object.create(inner) as FakeTTSProvider, {
    synthesize(request: TtsRequest) {
      said.push(request);
      if (fail) throw new Error('voice would not load');
      return inner.synthesize(request);
    },
    terminate() {
      log.push('tts terminated');
    },
  });
  return { tts, said };
}

const SETTINGS = { tts: { kind: 'kokoro-browser', voiceId: 'af_heart', speed: 1.1 } } as const;
const deps = {} as SettingsDeps;

describe('Speaker', () => {
  it('builds the audio graph first, warms the chosen voice, and hands both to the page', async () => {
    const log: string[] = [];
    const { tts, said } = recordingTts(log);
    const speaker = await Speaker.start({
      settings: SETTINGS,
      deps,
      consent: new ModelConsent(memoryStorage()),
      createAudio: async () => {
        log.push('audio');
        return fakeAudio(log);
      },
      buildTts: async () => {
        log.push('tts');
        return tts;
      },
    });

    expect(log).toEqual(['audio', 'tts']);
    expect(said.map((request) => [request.text, request.voiceId])).toEqual([[WARM_TEXT, 'af_heart']]);
    expect(speaker.voice).toMatchObject({ tts, voiceId: 'af_heart', speed: 1.1 });
    expect(speaker.voice.sink.enqueue({ samples: new Float32Array(1), sampleRate: 24_000 })).toBe(7);
    expect(speaker.output).not.toBeNull();

    await speaker.stop();
    await speaker.stop();
    expect(log.slice(2)).toEqual(['tts terminated', 'audio closed']);
  });

  it('leaves nothing running when the voice fails to load', async () => {
    const log: string[] = [];
    const { tts } = recordingTts(log, true);
    await expect(
      Speaker.start({
        settings: SETTINGS,
        deps,
        consent: new ModelConsent(memoryStorage()),
        createAudio: async () => fakeAudio(log),
        buildTts: async () => tts,
      }),
    ).rejects.toThrow('voice would not load');
    expect(log).toEqual(['tts terminated', 'audio closed']);
  });
});
