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
  withBodyChoice,
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
      memory: 'browser',
      initiative: 'rare',
      character: 'theo',
      characters: { theo: { voice: { kind: 'kokoro-browser', voiceId: 'bm_george', speed: 0.95 }, body: null }, alice: { voice: null, body: null } },
      tools: {
        servers: [{ id: 'srv-1', label: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', transport: 'http', enabled: true, auth: 'none' }],
        grants: { 'srv-1': { read_wiki_structure: { policy: 'auto', fingerprint: '0badf00d' }, ask_question: { policy: 'never', fingerprint: null } } },
        companion: true,
        homeArea: 'Kitchen',
      },
      documents: { search: true },
      llm: { endpoint: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', modelId: 'nemotron', temperature: 0.7 },
      tts: { kind: 'openai-compatible', baseUrl: 'http://x/v1', model: 'tts-1', voiceId: 'alloy', speed: 1.1 },
      stt: { kind: 'whisper-browser', model: 'whisper-tiny-en' },
      welcomed: true,
      closeToTray: false,
    };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('a document saved before tray mode closes to the tray (P8-T05)', () => {
    const storage = memoryStorage();
    const { closeToTray: _closeToTray, ...beforeTray } = DEFAULT_SETTINGS;
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(beforeTray));
    expect(loadSettings(storage).closeToTray).toBe(true);
  });

  it('loads a document saved before memory existed, remembering in this browser (P4-T04b)', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, companionUrl: 'http://127.0.0.1:9999' };
    const { memory: _memory, ...beforeP4 } = settings;
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(beforeP4) });
    expect(loadSettings(storage)).toEqual(settings);
    expect(settings.memory).toBe('browser');
  });

  it('loads a document saved before tools existed, with no servers and nothing decided (P5-T01)', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, companionUrl: 'http://127.0.0.1:9999' };
    const { tools: _tools, ...beforeP5 } = settings;
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(beforeP5) });
    expect(loadSettings(storage)).toEqual(settings);
    expect(settings.tools).toEqual({ servers: [], grants: {}, companion: false, homeArea: null });
  });

  it('loads a document saved before document search existed, with it off (P5-T04, ADR-45)', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, companionUrl: 'http://127.0.0.1:9999' };
    const { documents: _documents, ...beforeT04 } = settings;
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(beforeT04) });
    expect(loadSettings(storage)).toEqual(settings);
    expect(settings.documents).toEqual({ search: false });
  });

  it('loads a document saved before characters existed, as Alice with no voices chosen (P6-T06, ADR-55)', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, companionUrl: 'http://127.0.0.1:9999' };
    const { character: _character, characters: _characters, ...beforeT06 } = settings;
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(beforeT06) });
    expect(loadSettings(storage)).toEqual(settings);
    expect(settings.character).toBe('alice');
    expect(settings.characters).toEqual({});
  });

  it("keeps a Kokoro voice picked before characters existed as Alice's own, once (P6-T06, ADR-55)", () => {
    const { character: _character, characters: _characters, ...beforeT06 } = DEFAULT_SETTINGS;
    const picked = { ...beforeT06, tts: { kind: 'kokoro-browser', voiceId: 'bf_emma', speed: 1.1 } };
    const loaded = loadSettings(memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(picked) }));
    expect(loaded.characters).toEqual({ alice: { voice: { kind: 'kokoro-browser', voiceId: 'bf_emma', speed: 1.1 }, body: null } });
    expect(loaded.tts.voiceId).toBe('bf_emma');
    // Saved again, it has a characters key, so what she has is not written over by a later load.
    const storage = memoryStorage();
    saveSettings({ ...loaded, characters: { alice: { voice: null, body: null } } }, storage);
    expect(loadSettings(storage).characters).toEqual({ alice: { voice: null, body: null } });
  });

  it("writes no migrated voice when the old voice already is Alice's, or the engine is a server (P6-T06)", () => {
    const { character: _character, characters: _characters, ...beforeT06 } = DEFAULT_SETTINGS;
    const alices = loadSettings(memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(beforeT06) }));
    expect(alices.characters).toEqual({});
    const server = { ...beforeT06, tts: { kind: 'openai-compatible', baseUrl: 'http://x/v1', model: 'tts-1', voiceId: 'alloy', speed: 1 } };
    expect(loadSettings(memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(server) })).characters).toEqual({});
  });

  it("loads a character saved before bodies with the pack's default, and keeps the voice when a body is chosen (P7-T02, ADR-59)", () => {
    const before = { ...DEFAULT_SETTINGS, characters: { theo: { voice: { kind: 'kokoro-browser', voiceId: 'bm_george', speed: 0.9 } } } };
    const loaded = loadSettings(memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(before) }));
    expect(loaded.characters['theo']).toEqual({ voice: { kind: 'kokoro-browser', voiceId: 'bm_george', speed: 0.9 }, body: null });

    const chosen = withBodyChoice(loaded, 'theo', 'own:1');
    expect(chosen.characters['theo']).toEqual({ voice: { kind: 'kokoro-browser', voiceId: 'bm_george', speed: 0.9 }, body: 'own:1' });
    expect(withBodyChoice(chosen, 'alice', 'placeholder').characters['alice']).toEqual({ voice: null, body: 'placeholder' });
  });

  it('loads a document saved before the wizard as welcomed when a model was chosen, and not when none was (P8-T02)', () => {
    const { welcomed: _welcomed, ...beforeT02 } = DEFAULT_SETTINGS;
    const chosen = { ...beforeT02, llm: { endpoint: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3', temperature: null } };
    expect(loadSettings(memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(chosen) })).welcomed).toBe(true);
    // An endpoint with no model is not set up either.
    const half = { ...beforeT02, llm: { ...chosen.llm, modelId: null } };
    expect(loadSettings(memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(half) })).welcomed).toBe(false);
    expect(loadSettings(memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(beforeT02) })).welcomed).toBe(false);
  });

  it('keeps a saved welcomed value as it is, even with a model chosen (P8-T02)', () => {
    // "Run setup again" after finishing leaves true; a person who chose a model in the wizard but
    // has not finished it (false, saved with the field) must still meet the wizard.
    const midway = { ...DEFAULT_SETTINGS, llm: { endpoint: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3', temperature: null }, welcomed: false };
    expect(loadSettings(memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(midway) })).welcomed).toBe(false);
  });

  it('is not welcomed by default', () => {
    expect(DEFAULT_SETTINGS.welcomed).toBe(false);
    expect(loadSettings(memoryStorage()).welcomed).toBe(false);
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
