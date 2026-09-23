import { describe, expect, it, vi } from 'vitest';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import {
  KokoroBrowserTTSProvider,
  MoonshineBrowserSTTProvider,
  OpenAICompatibleSTTProvider,
  OpenAICompatibleTTSProvider,
  WhisperBrowserSTTProvider,
} from '@latentpresence/providers';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import type { MinimalCacheStorage } from '../consent/deps';
import type { SettingsDeps } from '../settings/deps';
import { DEFAULT_SETTINGS, STT_KEY_REF, TTS_KEY_REF, type Settings } from '../settings/settings';
import { InMemoryMasterKeyPort, Vault } from '../settings/vault';
import { buildSpeechProviders, buildTtsProvider } from './providers';

/**
 * The point of this module is that `/settings`'s two slots become the providers a call
 * runs on. Every case here is one of the four choices in those two selects, because the
 * failure this task exists to fix was a choice that saved and did nothing.
 */

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function testDeps(fetchFn: HttpFetch = async () => new Response('{}', { status: 200 })): SettingsDeps {
  const storage = memoryStorage();
  return {
    vault: new Vault(new InMemoryMasterKeyPort(), storage),
    storage,
    fetch: fetchFn,
    probe: async (): Promise<EndpointProbe> => ({ kind: 'answered', status: 200 }),
    origin: 'http://localhost:5173',
    now: () => Date.now(),
    createAudioContext: () => {
      throw new Error('not used in these tests');
    },
    consent: new ModelConsent(memoryStorage()),
    caches: {
      keys: async () => [],
      open: () => Promise.reject(new Error('not used in these tests')),
      delete: async () => false,
    } satisfies MinimalCacheStorage,
  };
}

function hearing(settings: Settings['stt']): Settings['stt'] {
  return settings;
}

/** The two server choices, written out as `/settings` would have saved them. */
const SERVER_TTS = {
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8880/v1',
  model: 'kokoro',
  voiceId: 'af_heart',
  speed: 1,
} satisfies Settings['tts'];
const SERVER_STT = {
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8880/v1',
  model: 'whisper-1',
  language: null,
} satisfies Settings['stt'];

/** One second of silence at the rate every recogniser here expects. */
async function* oneSilentSecond() {
  yield { samples: new Float32Array(16_000), sampleRate: 16_000, startMs: 0 };
}

/** What `navigator.gpu` answers on a machine that can actually run this. */
const WORKING_GPU = {
  requestAdapter: async () => ({ info: { vendor: 'nvidia', architecture: 'blackwell' } }),
};

describe('buildSpeechProviders — the four choices', () => {
  it('builds Kokoro and Moonshine from the defaults', async () => {
    const deps = testDeps();
    const speech = await buildSpeechProviders({ tts: DEFAULT_SETTINGS.tts, stt: DEFAULT_SETTINGS.stt }, deps, deps.consent, WORKING_GPU);
    expect(speech.tts).toBeInstanceOf(KokoroBrowserTTSProvider);
    expect(speech.stt).toBeInstanceOf(MoonshineBrowserSTTProvider);
  });

  it('builds Whisper for the Whisper choice rather than Moonshine', async () => {
    const deps = testDeps();
    const speech = await buildSpeechProviders(
      { tts: DEFAULT_SETTINGS.tts, stt: hearing({ kind: 'whisper-browser', model: 'whisper-tiny-en' }) },
      deps,
      deps.consent,
      WORKING_GPU,
    );
    expect(speech.stt).toBeInstanceOf(WhisperBrowserSTTProvider);
  });

  it('builds the server adapters for the server choices, and marks them remote', async () => {
    const deps = testDeps();
    const speech = await buildSpeechProviders({ tts: SERVER_TTS, stt: SERVER_STT }, deps, deps.consent, WORKING_GPU);
    expect(speech.tts).toBeInstanceOf(OpenAICompatibleTTSProvider);
    expect(speech.stt).toBeInstanceOf(OpenAICompatibleSTTProvider);
    expect((await speech.tts.capabilities()).runsInBrowser).toBe(false);
    expect((await speech.stt.capabilities()).runsInBrowser).toBe(false);
  });
});

describe('buildSpeechProviders — a browser that cannot run this', () => {
  it('refuses before building anything, in words a person can act on', async () => {
    // `kokoroSupport` was written in P1-T05 for "the settings UI steers on it" and nothing
    // ever called it, so this path used to reach onnxruntime and die there. The detail is
    // Spike E's: `navigator.gpu` is undefined in WebKitGTK, and a software adapter passes a
    // naive check while missing every budget.
    const deps = testDeps();
    await expect(buildSpeechProviders(DEFAULT_SETTINGS, deps, deps.consent, null)).rejects.toThrow(
      /navigator\.gpu is undefined/u,
    );
    await expect(
      buildSpeechProviders(DEFAULT_SETTINGS, deps, deps.consent, {
        requestAdapter: async () => ({ info: { description: 'google / swiftshader' } }),
      }),
    ).rejects.toThrow(/software rasteriser/u);
  });

  it('says Chrome or Edge rather than naming a setting that would not help', async () => {
    // The turn models are browser ones whichever Voice and Hearing source is chosen, so
    // "pick a server" would be advice that fails one step later.
    const deps = testDeps();
    await expect(buildSpeechProviders({ tts: SERVER_TTS, stt: SERVER_STT }, deps, deps.consent, null)).rejects.toThrow(
      /Chrome or Edge with hardware acceleration/u,
    );
  });
});

describe('buildSpeechProviders — the keys /settings saved', () => {
  it('sends the voice server the key from its own vault slot', async () => {
    const sent: Record<string, string>[] = [];
    const deps = testDeps(async (_input, init) => {
      sent.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('nope', { status: 500 });
    });
    await deps.vault.saveKey(TTS_KEY_REF, 'voice-secret');
    const { tts } = await buildSpeechProviders({ tts: SERVER_TTS, stt: DEFAULT_SETTINGS.stt }, deps, deps.consent, WORKING_GPU);

    await expect(
      (async () => {
        for await (const chunk of tts.synthesize({ text: 'Hello.', voiceId: 'af_heart', speed: 1, hint: null })) void chunk;
      })(),
    ).rejects.toThrow(/500/u);

    expect(sent.at(0)?.['authorization']).toBe('Bearer voice-secret');
  });

  it('sends the hearing server its key, its base URL and its language', async () => {
    const urls: string[] = [];
    const bodies: FormData[] = [];
    const deps = testDeps(async (input, init) => {
      urls.push(String(input));
      bodies.push(init?.body as FormData);
      return new Response(JSON.stringify({ text: 'hello there' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await deps.vault.saveKey(STT_KEY_REF, 'hearing-secret');
    const speech = await buildSpeechProviders(
      { tts: DEFAULT_SETTINGS.tts, stt: hearing({ ...SERVER_STT, language: 'en' }) },
      deps,
      deps.consent,
      WORKING_GPU,
    );

    let text = '';
    for await (const result of speech.stt.transcribe(oneSilentSecond())) text = result.text;

    expect(text).toBe('hello there');
    expect(urls[0]).toBe('http://127.0.0.1:8880/v1/audio/transcriptions');
    expect(bodies[0]?.get('model')).toBe('whisper-1');
    expect(bodies[0]?.get('language')).toBe('en');
  });
});

describe('buildSpeechProviders — stopping a call', () => {
  it('disposes the browser workers it built, and survives a provider without one', async () => {
    const deps = testDeps();
    const speech = await buildSpeechProviders({ tts: DEFAULT_SETTINGS.tts, stt: DEFAULT_SETTINGS.stt }, deps, deps.consent, WORKING_GPU);
    // Neither provider has started its worker (nothing has been synthesised), so the spy is
    // the only way to see that dispose asks at all — and a 325 MB worker left running for
    // the life of the page is exactly what this call is for.
    const stopTts = vi.spyOn(speech.tts as unknown as { terminate: () => void }, 'terminate');
    const stopStt = vi.spyOn(speech.stt as unknown as { terminate: () => void }, 'terminate');

    speech.dispose();

    expect(stopTts).toHaveBeenCalledTimes(1);
    expect(stopStt).toHaveBeenCalledTimes(1);
  });

  it('does nothing for two server providers', async () => {
    const deps = testDeps();
    const speech = await buildSpeechProviders({ tts: SERVER_TTS, stt: SERVER_STT }, deps, deps.consent, WORKING_GPU);
    expect(() => speech.dispose()).not.toThrow();
  });
});

describe('buildTtsProvider (P2-T08)', () => {
  it('builds the voice alone, and a server voice needs no WebGPU', async () => {
    const deps = testDeps();
    expect(await buildTtsProvider({ tts: DEFAULT_SETTINGS.tts }, deps, deps.consent, WORKING_GPU)).toBeInstanceOf(KokoroBrowserTTSProvider);
    expect(await buildTtsProvider({ tts: SERVER_TTS }, deps, deps.consent, null)).toBeInstanceOf(OpenAICompatibleTTSProvider);
  });

  it('refuses a browser voice without WebGPU, in the same words a call does', async () => {
    const deps = testDeps();
    await expect(buildTtsProvider({ tts: DEFAULT_SETTINGS.tts }, deps, deps.consent, null)).rejects.toThrow(/Chrome or Edge/u);
  });
});
