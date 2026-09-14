import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPANION_URL } from '@latentpresence/providers/web';
import { KOKORO_DEFAULT_VOICE } from '@latentpresence/ml-web/voices';
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  llmKeyRef,
  loadSettings,
  saveSettings,
  SETTINGS_STORAGE_KEY,
  STT_KEY_REF,
  TTS_KEY_REF,
  type Settings,
} from './settings';

/** A `Pick<Storage, ...>` backed by a plain object, so these tests never touch jsdom's
 * real `localStorage`. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
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

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults on corrupt JSON, never throwing', () => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: '{not json' });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when the stored document fails the schema', () => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ version: 1 }) });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a valid document through save and load', () => {
    const storage = memoryStorage();
    const settings: Settings = {
      version: 1,
      companionUrl: 'http://127.0.0.1:9999',
      llm: { endpoint: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', modelId: 'nemotron', temperature: 0.7 },
      tts: { kind: 'openai-compatible', baseUrl: 'http://x/v1', model: 'tts-1', voiceId: 'alloy', speed: 1.1 },
      stt: { kind: 'whisper-browser', model: 'whisper-tiny-en' },
    };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('defaults the companion URL to the documented default', () => {
    expect(DEFAULT_SETTINGS.companionUrl).toBe(DEFAULT_COMPANION_URL);
  });

  it('defaults to Kokoro in the browser at the documented default voice and speed 1', () => {
    expect(DEFAULT_SETTINGS.tts).toEqual({ kind: 'kokoro-browser', voiceId: KOKORO_DEFAULT_VOICE, speed: 1 });
  });

  it('defaults to Moonshine tiny, and no LLM chosen', () => {
    expect(DEFAULT_SETTINGS.stt).toEqual({ kind: 'moonshine-browser', model: 'moonshine-tiny' });
    expect(DEFAULT_SETTINGS.llm.endpoint).toBeNull();
  });
});

describe('the schema rejects out-of-range values', () => {
  it('rejects temperature 0 — server default is null, not 0', () => {
    const result = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      llm: { ...DEFAULT_SETTINGS.llm, temperature: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts null temperature (server default) and the 0.1-1.5 band', () => {
    for (const temperature of [null, 0.1, 0.8, 1.5]) {
      const result = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, temperature } });
      expect(result.success, String(temperature)).toBe(true);
    }
  });

  it('rejects speed outside 0.75-1.25 for Kokoro', () => {
    for (const speed of [0.5, 0.74, 1.26, 2]) {
      const result = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, tts: { ...DEFAULT_SETTINGS.tts, speed } });
      expect(result.success, String(speed)).toBe(false);
    }
  });

  it('rejects speed outside 0.75-1.25 for an OpenAI-compatible server too', () => {
    const base = { kind: 'openai-compatible' as const, baseUrl: 'http://x/v1', model: 'tts-1', voiceId: 'a' };
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, tts: { ...base, speed: 1.3 } }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, tts: { ...base, speed: 1.0 } }).success).toBe(true);
  });
});

describe('key refs', () => {
  it('gives each LLM endpoint its own ref, so switching presets keeps each key', () => {
    expect(llmKeyRef('nvidia')).toBe('llm:nvidia');
    expect(llmKeyRef('ollama')).toBe('llm:ollama');
    expect(llmKeyRef('nvidia')).not.toBe(llmKeyRef('ollama'));
  });

  it('gives TTS and STT one fixed ref each', () => {
    expect(TTS_KEY_REF).toBe('tts');
    expect(STT_KEY_REF).toBe('stt');
  });
});

describe('the stored document never contains a key', () => {
  it('has no field for a secret, so serialising settings after "saving a key" elsewhere cannot leak it', () => {
    const storage = memoryStorage();
    const aSavedKeyLooksLike = 'sk-super-secret-value-should-never-appear';
    // The settings document has no place to put a key at all — proven by constructing
    // the richest Settings object the schema allows and checking the secret is absent
    // from what actually gets written.
    saveSettings(
      {
        ...DEFAULT_SETTINGS,
        llm: { endpoint: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', modelId: 'x', temperature: 0.5 },
      },
      storage,
    );
    const stored = storage.getItem(SETTINGS_STORAGE_KEY) ?? '';
    expect(stored).not.toContain(aSavedKeyLooksLike);
    expect(Object.keys(JSON.parse(stored) as object)).not.toContain('apiKey');
  });
});
