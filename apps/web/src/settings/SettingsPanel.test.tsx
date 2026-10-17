import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import type { MinimalCacheStorage } from '../consent/deps';
import { initDesktop, resetDesktopForTests, type Invoke } from '../desktop/desktop';
import type { SettingsDeps } from './deps';
import { InMemoryMasterKeyPort, Vault } from './vault';
import { SettingsPanel } from './SettingsPanel';

afterEach(() => {
  cleanup();
  resetDesktopForTests();
});

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

/** No caches at all — jsdom implements none of Cache Storage, and these tests are not
 * about the Downloaded-models section, so an empty in-memory stand-in is enough. */
function emptyCaches(): MinimalCacheStorage {
  return {
    keys: async () => [],
    open: () => Promise.reject(new Error('no cache in these tests')),
    delete: async () => false,
  };
}

/** Deps for a panel test: an in-memory vault and storage, and stubs for fetch/probe that
 * a test overrides as needed. Nothing here reaches the network. */
function testDeps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  return {
    vault: new Vault(new InMemoryMasterKeyPort(), memoryStorage()),
    storage: memoryStorage(),
    fetch: (async () => new Response('{}', { status: 200 })) as HttpFetch,
    probe: async (): Promise<EndpointProbe> => ({ kind: 'answered', status: 200 }),
    origin: 'http://localhost:5173',
    now: () => Date.now(),
    createAudioContext: () => {
      throw new Error('not used in these tests');
    },
    consent: new ModelConsent(memoryStorage()),
    caches: emptyCaches(),
    ...overrides,
  };
}

function selectEndpoint(label: string): void {
  fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: optionValueFor(label) } });
}

/** The presets use their preset id as the option value; the label text alone does
 * not say it, so tests name the id they expect for the option they pick. */
function optionValueFor(label: string): string {
  const option = screen.getByRole('option', { name: label }) as HTMLOptionElement;
  return option.value;
}

const ollamaFetchWithOneEmbeddingModel: HttpFetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/api/version')) return new Response('{"version":"0.34.0"}', { status: 200 });
  if (url.endsWith('/api/tags')) {
    return new Response(
      JSON.stringify({
        models: [
          { name: 'llama3', capabilities: ['completion'] },
          { name: 'embed-only', capabilities: ['embedding'] },
        ],
      }),
      { status: 200 },
    );
  }
  return new Response('{}', { status: 200 });
};

describe('SettingsPanel — Language model', () => {
  it('picking LM Studio fills its default base URL', () => {
    render(<SettingsPanel deps={testDeps()} />);
    selectEndpoint('LM Studio');
    expect(screen.getByLabelText('Base URL')).toHaveProperty('value', 'http://127.0.0.1:1234/v1');
  });

  it('a cors-blocked test shows the "Enable CORS" help', async () => {
    const deps = testDeps({ probe: async (): Promise<EndpointProbe> => ({ kind: 'cors-blocked' }) });
    render(<SettingsPanel deps={deps} />);
    selectEndpoint('LM Studio');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText(/Enable CORS/)).toBeTruthy());
  });

  it('picking NVIDIA shows the key field and the companion field', () => {
    render(<SettingsPanel deps={testDeps()} />);
    selectEndpoint('NVIDIA NIM');
    expect(screen.getByLabelText('API key')).toBeTruthy();
    expect(screen.getByLabelText('Companion URL')).toBeTruthy();
    // R-5: the start command is on screen before any test fails, not only after.
    expect(screen.getByText('pnpm companion').tagName).toBe('CODE');
  });

  it('a saved key never appears in the DOM', async () => {
    const { container } = render(<SettingsPanel deps={testDeps()} />);
    selectEndpoint('NVIDIA NIM');
    const secret = 'nv-super-secret-value-12345';
    fireEvent.change(screen.getByPlaceholderText('Paste a key'), { target: { value: secret } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Key saved')).toBeTruthy());
    expect(container.innerHTML).not.toContain(secret);
  });

  // R-56 (2026-10-17): a pasted key with no press of Save tested with no key, and the
  // listing after a passing probe was sent without one ("v1/models 401").
  it('a key typed but not saved is saved on leaving the field, and both the probe and the listing carry it', async () => {
    const probed: (Record<string, string> | undefined)[] = [];
    const listed: (string | null)[] = [];
    const deps = testDeps({
      probe: async (_url, options): Promise<EndpointProbe> => {
        probed.push(options?.headers as Record<string, string> | undefined);
        return { kind: 'answered', status: 200 };
      },
      fetch: (async (_input, init) => {
        listed.push(new Headers(init?.headers).get('authorization'));
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 });
      }) as HttpFetch,
    });
    render(<SettingsPanel deps={deps} />);
    selectEndpoint('DeepSeek');
    const field = screen.getByPlaceholderText('Paste a key');
    fireEvent.change(field, { target: { value: 'sk-typed' } });
    fireEvent.blur(field);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'deepseek-chat' })).toBeTruthy());
    expect(screen.getByText('Key saved')).toBeTruthy();
    expect(probed[0]?.['authorization']).toBe('Bearer sk-typed');
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((value) => value === 'Bearer sk-typed')).toBe(true);
  });

  it('Enter in the key field saves it', async () => {
    render(<SettingsPanel deps={testDeps()} />);
    selectEndpoint('DeepSeek');
    const field = screen.getByPlaceholderText('Paste a key');
    fireEvent.change(field, { target: { value: 'sk-enter' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Key saved')).toBeTruthy());
  });

  it('Ollama Cloud goes through the companion, like NVIDIA', () => {
    render(<SettingsPanel deps={testDeps()} />);
    selectEndpoint('Ollama Cloud');
    expect(screen.getByLabelText('Base URL')).toHaveProperty('value', 'https://ollama.com/v1');
    expect(screen.getByLabelText('Companion URL')).toBeTruthy();
  });

  it('the model picker hides embedding-only models, once a test finds some', async () => {
    render(<SettingsPanel deps={testDeps({ fetch: ollamaFetchWithOneEmbeddingModel })} />);
    selectEndpoint('Ollama');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'llama3' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'embed-only' })).toBeNull();
  });

  it('after a reload the saved model still shows as chosen, before any new test', () => {
    const storage = memoryStorage();
    storage.setItem(
      'latentpresence.settings.v1',
      JSON.stringify({
        version: 1,
        companionUrl: 'http://127.0.0.1:8787',
        llm: { endpoint: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3', temperature: null },
        tts: { kind: 'kokoro-browser', voiceId: 'af_heart', speed: 1 },
        stt: { kind: 'moonshine-browser', model: 'moonshine-tiny' },
      }),
    );
    const { container } = render(<SettingsPanel deps={testDeps({ storage })} />);
    const picker = container.querySelector('#settings-llm-model') as HTMLSelectElement;
    expect(picker.value).toBe('llama3');
    expect(picker.disabled).toBe(false);
  });

  it('the temperature control cannot reach 0', () => {
    render(<SettingsPanel deps={testDeps()} />);
    const slider = screen.getByLabelText('Temperature') as HTMLInputElement;
    expect(slider.min).toBe('0.1');
  });
});

describe('SettingsPanel — Documents (P5-T04, ADR-45)', () => {
  it('the search switch is off, turns on, and is saved in the settings document', async () => {
    const storage = memoryStorage();
    render(<SettingsPanel deps={testDeps({ storage })} />);
    const toggle = screen.getByRole('switch', { name: 'Let her search these documents' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect((screen.getByRole('switch', { name: 'Let her search these documents' }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(JSON.parse(storage.getItem('latentpresence.settings.v1') ?? '{}').documents).toEqual({ search: true }));
    fireEvent.click(screen.getByRole('switch', { name: 'Let her search these documents' }));
    await waitFor(() => expect(JSON.parse(storage.getItem('latentpresence.settings.v1') ?? '{}').documents).toEqual({ search: false }));
  });
});

describe('SettingsPanel — Voice', () => {
  it('the speed control is bounded to 0.75-1.25', () => {
    render(<SettingsPanel deps={testDeps()} />);
    const slider = screen.getByLabelText('Speed') as HTMLInputElement;
    expect(slider.min).toBe('0.75');
    expect(slider.max).toBe('1.25');
  });

  it('offers Play sample for a server only, never for browser Kokoro, which is not downloaded yet', () => {
    render(<SettingsPanel deps={testDeps()} />);
    expect(screen.queryByRole('button', { name: 'Play sample' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Source', { selector: '#settings-tts-kind' }), { target: { value: 'openai-compatible' } });
    expect(screen.getByRole('button', { name: 'Play sample' })).toBeTruthy();
  });
});

function stored(storage: Storage): Record<string, unknown> {
  return JSON.parse(storage.getItem('latentpresence.settings.v1') ?? '{}') as Record<string, unknown>;
}

describe('SettingsPanel — Character (P6-T06, ADR-55)', () => {
  it('offers every character, with Alice active and her summary shown', () => {
    render(<SettingsPanel deps={testDeps()} />);
    const picker = screen.getByLabelText('Talking to') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(['Alice', 'Theo']);
    expect(picker.value).toBe('alice');
    expect(screen.getByText(/^Alice is /)).toBeTruthy();
  });

  it('choosing Theo is saved as the active character and shows his summary and his own voice', async () => {
    const storage = memoryStorage();
    render(<SettingsPanel deps={testDeps({ storage })} />);
    fireEvent.change(screen.getByLabelText('Talking to'), { target: { value: 'theo' } });
    await waitFor(() => expect(stored(storage).character).toBe('theo'));
    expect(screen.getByText(/^Theo is /)).toBeTruthy();
    expect(screen.getByRole('option', { name: "Theo's own (am_michael)" })).toBeTruthy();
  });

  it("a Kokoro voice chosen for Theo is saved under his id with the engine's kind, and the first option clears it", async () => {
    const storage = memoryStorage();
    render(<SettingsPanel deps={testDeps({ storage })} />);
    fireEvent.change(screen.getByLabelText('Talking to'), { target: { value: 'theo' } });
    const voice = screen.getByLabelText('Voice for Theo') as HTMLSelectElement;
    expect(voice.value).toBe('');
    fireEvent.change(voice, { target: { value: 'bm_george' } });
    await waitFor(() => expect(stored(storage).characters).toEqual({ theo: { voice: { kind: 'kokoro-browser', voiceId: 'bm_george', speed: 1 }, body: null } }));
    expect((screen.getByLabelText('Voice for Theo') as HTMLSelectElement).value).toBe('bm_george');
    fireEvent.change(screen.getByLabelText('Voice for Theo'), { target: { value: '' } });
    await waitFor(() => expect(stored(storage).characters).toEqual({ theo: { voice: null, body: null } }));
  });

  it("on a server it is a voice id for the character, blank meaning the one in Voice, and a Kokoro choice is not shown there", async () => {
    const storage = memoryStorage();
    storage.setItem(
      'latentpresence.settings.v1',
      JSON.stringify({
        version: 1,
        companionUrl: 'http://127.0.0.1:8787',
        llm: { endpoint: null, baseUrl: '', modelId: null, temperature: null },
        tts: { kind: 'openai-compatible', baseUrl: 'http://x/v1', model: 'tts-1', voiceId: 'alloy', speed: 1 },
        stt: { kind: 'moonshine-browser', model: 'moonshine-tiny' },
        characters: { alice: { voice: { kind: 'kokoro-browser', voiceId: 'bf_emma', speed: 1 }, body: null } },
      }),
    );
    render(<SettingsPanel deps={testDeps({ storage })} />);
    const voice = screen.getByLabelText('Voice for Alice') as HTMLInputElement;
    expect(voice.value).toBe('');
    fireEvent.change(voice, { target: { value: 'nova' } });
    await waitFor(() =>
      expect(stored(storage).characters).toEqual({
        alice: { voice: { kind: 'openai-compatible', voiceId: 'nova', speed: 1 }, body: null },
      }),
    );
    fireEvent.change(screen.getByLabelText('Voice for Alice'), { target: { value: '' } });
    await waitFor(() => expect(stored(storage).characters).toEqual({ alice: { voice: null, body: null } }));
  });
});

describe('SettingsPanel — where keys are kept (R-56, P8-T02)', () => {
  it('says encrypted browser storage in a browser', () => {
    const { container } = render(<SettingsPanel deps={testDeps()} />);
    expect(container.textContent).toContain("Keys are encrypted in this browser's storage");
  });

  it('says Windows Credential Manager in the desktop app, not browser storage', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'os_notifications' ? false : { url: 'http://127.0.0.1:8790', token: 'tok' },
    ) as unknown as Invoke;
    await initDesktop({ __TAURI__: { core: { invoke } }, fetch: vi.fn() as unknown as typeof fetch });
    const { container } = render(<SettingsPanel deps={testDeps()} />);
    expect(container.textContent).toContain("Keys are kept in Windows Credential Manager, not in this app's storage.");
    expect(container.textContent).not.toContain('encrypted in this browser');
  });
});
