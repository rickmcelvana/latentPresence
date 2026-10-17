import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import { AVATAR_DESCRIPTOR } from '../call/character-asset';
import type { MinimalCacheStorage } from '../consent/deps';
import { initDesktop, resetDesktopForTests, type Invoke } from '../desktop/desktop';
import type { SettingsDeps } from '../settings/deps';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings, type Settings } from '../settings/settings';
import { InMemoryMasterKeyPort, Vault } from '../settings/vault';
import { browserModelsFor } from '../voice/models';
import type { WizardDevices } from './devices';
import { Wizard } from './Wizard';

afterEach(() => {
  cleanup();
  resetDesktopForTests();
  vi.restoreAllMocks();
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

function emptyCaches(): MinimalCacheStorage {
  return { keys: async () => [], open: () => Promise.reject(new Error('no cache in these tests')), delete: async () => false };
}

const health = (database: { kind: 'mariadb' | 'sqlite' | 'none'; connected: boolean }): HttpFetch =>
  (async () =>
    new Response(JSON.stringify({ status: 'ok', service: 'latentpresence-companion', version: '0.0.0', database }), { status: 200 })) as HttpFetch;

/** Deps for a wizard test: in-memory everything. Nothing here reaches the network or a device. */
function testDeps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  return {
    vault: new Vault(new InMemoryMasterKeyPort(), memoryStorage()),
    storage: memoryStorage(),
    fetch: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as HttpFetch,
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

function saved(storage: Pick<Storage, 'getItem'>): Settings {
  return loadSettings(storage);
}

interface FakeMedia {
  readonly devices: WizardDevices;
  readonly getUserMedia: ReturnType<typeof vi.fn>;
  readonly tracks: { stop: ReturnType<typeof vi.fn> }[];
  readonly stopMeter: ReturnType<typeof vi.fn>;
}

/** A microphone and camera that open when asked and record that every track was stopped. */
function fakeMedia(options: { fail?: string; durationMs?: number } = {}): FakeMedia {
  const tracks: { stop: ReturnType<typeof vi.fn> }[] = [];
  const stopMeter = vi.fn();
  const getUserMedia = vi.fn(async () => {
    if (options.fail !== undefined) {
      const error = new Error('refused');
      error.name = options.fail;
      throw error;
    }
    const track = { stop: vi.fn() };
    tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  return {
    devices: { getUserMedia, startLevelMeter: vi.fn(() => stopMeter), durationMs: options.durationMs ?? 30 },
    getUserMedia,
    tracks,
    stopMeter,
  };
}

async function inTheApp(): Promise<void> {
  const invoke = vi.fn(async (command: string) =>
    command === 'os_notifications'
      ? false
      : command === 'database_info'
        ? { saved: false, address: null }
        : { url: 'http://127.0.0.1:8790', token: 'tok' },
  ) as unknown as Invoke;
  await initDesktop({ __TAURI__: { core: { invoke } }, fetch: vi.fn() as unknown as typeof fetch });
}

function heading(): string {
  return screen.getByRole('heading', { level: 1 }).textContent ?? '';
}

function press(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

const OLLAMA_WITH_LLAMA: HttpFetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/api/version')) return new Response('{"version":"0.34.0"}', { status: 200 });
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'llama3', capabilities: ['completion'] }] }), { status: 200 });
  return new Response('{}', { status: 200 });
};

describe('Wizard — the steps', () => {
  it('walks welcome, model, character, memory, voice and done, and Back returns', () => {
    render(<Wizard deps={testDeps()} navigate={() => {}} />);
    expect(heading()).toBe('Welcome to latentPresence');
    expect(screen.getByText('1 of 6')).toBeTruthy();

    press('Set up');
    expect(heading()).toBe('Choose a language model');
    expect(screen.getByText('2 of 6')).toBeTruthy();

    press('Skip for now');
    expect(heading()).toBe('Choose who you talk to');
    expect(screen.getByText('3 of 6')).toBeTruthy();

    press('Next');
    expect(heading()).toBe('Choose where she remembers');
    expect(screen.getByText('4 of 6')).toBeTruthy();

    press('Next');
    expect(heading()).toBe('Voice and hearing');
    expect(screen.getByText('5 of 6')).toBeTruthy();

    press('Skip for now');
    expect(heading()).toBe('You are ready');
    expect(screen.getByText('6 of 6')).toBeTruthy();

    press('Back');
    expect(heading()).toBe('Voice and hearing');
    press('Back');
    press('Back');
    press('Back');
    expect(heading()).toBe('Choose a language model');
    press('Back');
    expect(heading()).toBe('Welcome to latentPresence');
  });

  it('moves focus to the step heading when the step changes', () => {
    render(<Wizard deps={testDeps()} navigate={() => {}} />);
    press('Set up');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    press('Skip for now');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('says what it is in plain words and names no jargon on the first step', () => {
    const { container } = render(<Wizard deps={testDeps()} navigate={() => {}} />);
    expect(container.textContent).toContain('ships none');
    expect(container.textContent).toContain('Nothing leaves this computer');
    expect(container.textContent).not.toMatch(/LLM|CORS|IndexedDB|VRM|relay/);
  });
});

describe('Wizard — the language model step', () => {
  it('has Next disabled until a model is chosen, and offers Skip for now meanwhile', async () => {
    const deps = testDeps({ fetch: OLLAMA_WITH_LLAMA });
    render(<Wizard deps={deps} initialStep={1} navigate={() => {}} />);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: (screen.getByRole('option', { name: 'Ollama' }) as HTMLOptionElement).value } });
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'llama3' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'llama3' } });

    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    // Saved as it was chosen, so closing the window here loses nothing.
    expect(saved(deps.storage).llm).toMatchObject({ endpoint: 'ollama', modelId: 'llama3' });
  });

  it('enables Next at once when a model was already chosen', () => {
    const storage = memoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, llm: { endpoint: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3', temperature: null } }),
    );
    render(<Wizard deps={testDeps({ storage })} initialStep={1} navigate={() => {}} />);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says where keys are kept: this browser, or Windows Credential Manager in the app', async () => {
    const browser = render(<Wizard deps={testDeps()} initialStep={1} navigate={() => {}} />);
    expect(browser.container.textContent).toContain("encrypted in this browser's storage");
    browser.unmount();

    await inTheApp();
    const app = render(<Wizard deps={testDeps()} initialStep={1} navigate={() => {}} />);
    expect(app.container.textContent).toContain('Windows Credential Manager');
    expect(app.container.textContent).not.toContain('encrypted in this browser');
  });
});

describe('Wizard — the character step and the body consent', () => {
  it('saves the character as it is chosen', () => {
    const deps = testDeps();
    render(<Wizard deps={deps} initialStep={2} navigate={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /Theo/ }));
    expect(saved(deps.storage).character).toBe('theo');
    fireEvent.click(screen.getByRole('radio', { name: /Alice/ }));
    expect(saved(deps.storage).character).toBe('alice');
  });

  it('records consent for her body on Show the character, and fetches nothing', () => {
    const deps = testDeps();
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    render(<Wizard deps={deps} initialStep={2} navigate={() => {}} />);
    expect(deps.consent.has([AVATAR_DESCRIPTOR])).toBe(false);
    press('Show the character');
    expect(deps.consent.has([AVATAR_DESCRIPTOR])).toBe(true);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('records nothing on Not now, fetches nothing, and still lets the person go on', () => {
    const deps = testDeps();
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    render(<Wizard deps={deps} initialStep={2} navigate={() => {}} />);
    press('Not now');
    expect(deps.consent.has([AVATAR_DESCRIPTOR])).toBe(false);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(screen.getByText(/Chat asks again/)).toBeTruthy();
    press('Next');
    expect(heading()).toBe('Choose where she remembers');
  });

  it('names the source, size and licence on the consent screen, and says GitHub', () => {
    const { container } = render(<Wizard deps={testDeps()} initialStep={2} navigate={() => {}} />);
    expect(container.textContent).toContain('GitHub');
    expect(container.textContent).not.toContain('Hugging Face');
    expect(container.textContent).toContain('MB');
  });
});

function chooseMariaDb(): void {
  fireEvent.click(screen.getByRole('radio', { name: /A MariaDB server/ }));
}

describe('Wizard — the memory step', () => {
  it('offers three choices, recommends this computer, and saves a choice at once', () => {
    const deps = testDeps();
    render(<Wizard deps={deps} initialStep={3} navigate={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect((screen.getByRole('radio', { name: /On this computer/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Recommended')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Don't remember/ }));
    expect(saved(deps.storage).memory).toBe('off');
    chooseMariaDb();
    expect(saved(deps.storage).memory).toBe('companion');
  });

  it('shows the browser steps with the exact command, and what happens until it works', () => {
    const { container } = render(<Wizard deps={testDeps()} initialStep={3} navigate={() => {}} />);
    expect(container.textContent).not.toContain('DATABASE_URL');
    chooseMariaDb();
    expect(container.textContent).toContain('MariaDB 11.8 or newer');
    expect(screen.getByText('pnpm companion').tagName).toBe('CODE');
    expect(container.textContent).toContain('.env');
    expect(container.textContent).toContain('Nothing is remembered while the companion has no database');
    // A passing check is not required.
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('in the desktop app, asks for the database address itself (ADR-62): no variables, no terminal', async () => {
    await inTheApp();
    const { container } = render(<Wizard deps={testDeps()} initialStep={3} navigate={() => {}} />);
    chooseMariaDb();
    expect(await screen.findByLabelText('Database address')).toBeTruthy();
    expect(container.textContent).toContain('Windows Credential Manager');
    expect(container.textContent).not.toContain('environment variables');
    expect(container.textContent).not.toContain('pnpm companion');
  });

  it('says MariaDB is not available on a hosted page', () => {
    const { container } = render(<Wizard deps={testDeps({ origin: 'https://app.latentpresence.com' })} initialStep={3} navigate={() => {}} />);
    chooseMariaDb();
    expect(container.textContent).toContain('MariaDB is not available here');
  });

  it('Check: connected', async () => {
    render(<Wizard deps={testDeps({ fetch: health({ kind: 'mariadb', connected: true }) })} initialStep={3} navigate={() => {}} />);
    chooseMariaDb();
    press('Check');
    await waitFor(() => expect(screen.getByText(/Connected\. The companion reached your MariaDB database/)).toBeTruthy());
  });

  it('Check: the companion runs with no DATABASE_URL', async () => {
    render(<Wizard deps={testDeps({ fetch: health({ kind: 'none', connected: false }) })} initialStep={3} navigate={() => {}} />);
    chooseMariaDb();
    press('Check');
    await waitFor(() => expect(screen.getByText(/running but has no database address/)).toBeTruthy());
  });

  it('Check: a database that does not answer is said apart from none', async () => {
    render(<Wizard deps={testDeps({ fetch: health({ kind: 'mariadb', connected: false }) })} initialStep={3} navigate={() => {}} />);
    chooseMariaDb();
    press('Check');
    await waitFor(() => expect(screen.getByText(/could not connect to it/)).toBeTruthy());
  });

  it('Check: no companion running, in a browser (start it) and in the app (restart)', async () => {
    const refused = (async () => {
      throw new TypeError('Failed to fetch');
    }) as HttpFetch;
    const browser = render(<Wizard deps={testDeps({ fetch: refused })} initialStep={3} navigate={() => {}} />);
    chooseMariaDb();
    press('Check');
    await waitFor(() => expect(screen.getByText(/The companion is not running at/)).toBeTruthy());
    browser.unmount();

    await inTheApp();
    render(<Wizard deps={testDeps({ fetch: refused })} initialStep={3} navigate={() => {}} />);
    chooseMariaDb();
    press('Check');
    await waitFor(() => expect(screen.getByText(/quit the app and open it again/)).toBeTruthy());
  });

  it('Check asks the companion at the saved address, and nothing else', async () => {
    const fetch = vi.fn(health({ kind: 'mariadb', connected: true }));
    const storage = memoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, companionUrl: 'http://127.0.0.1:9999/' }));
    render(<Wizard deps={testDeps({ fetch: fetch as HttpFetch, storage })} initialStep={3} navigate={() => {}} />);
    chooseMariaDb();
    expect(fetch).not.toHaveBeenCalled();
    press('Check');
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9999/health');
  });
});

describe('Wizard — the voice step', () => {
  it('records consent for exactly the models listed on Agree, and fetches nothing', () => {
    const deps = testDeps();
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const media = fakeMedia();
    render(<Wizard deps={deps} devices={media.devices} initialStep={4} navigate={() => {}} />);
    const models = browserModelsFor(DEFAULT_SETTINGS);
    expect(deps.consent.has(models)).toBe(false);
    press('Agree');
    expect(deps.consent.has(models)).toBe(true);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    // And no device was opened by agreeing.
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });

  it('records nothing on Not now (text only), and the summary says text only', () => {
    const deps = testDeps();
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    render(<Wizard deps={deps} devices={fakeMedia().devices} initialStep={4} navigate={() => {}} />);
    press('Not now (text only)');
    expect(deps.consent.has(browserModelsFor(DEFAULT_SETTINGS))).toBe(false);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Test microphone' })).toBeNull();
    press('Next');
    expect(heading()).toBe('You are ready');
    expect(screen.getByText('Text only for now.')).toBeTruthy();
  });

  it('opens nothing until Test microphone is pressed, then stops every track', async () => {
    const media = fakeMedia();
    render(<Wizard deps={testDeps()} devices={media.devices} initialStep={4} navigate={() => {}} />);
    press('Agree');
    expect(media.getUserMedia).not.toHaveBeenCalled();

    press('Test microphone');
    await waitFor(() => expect(screen.getByText(/Say something and the bar should move/)).toBeTruthy());
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(media.tracks[0]?.stop).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByText('Microphone works.')).toBeTruthy());
    expect(media.tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(media.stopMeter).toHaveBeenCalledTimes(1);
  });

  it('stops the microphone when the person leaves the step mid-test', async () => {
    const media = fakeMedia({ durationMs: 60_000 });
    render(<Wizard deps={testDeps()} devices={media.devices} initialStep={4} navigate={() => {}} />);
    press('Agree');
    press('Test microphone');
    await waitFor(() => expect(screen.getByText(/Say something/)).toBeTruthy());
    press('Back');
    expect(media.tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(media.stopMeter).toHaveBeenCalledTimes(1);
  });

  it('tests the camera on its own button, shows a preview, and stops it', async () => {
    const media = fakeMedia();
    render(<Wizard deps={testDeps()} devices={media.devices} initialStep={4} navigate={() => {}} />);
    press('Agree');
    expect(screen.getByText(/only used for .Read my face/)).toBeTruthy();
    press('Test camera');
    await waitFor(() => expect(screen.getByLabelText('Camera preview')).toBeTruthy());
    expect(media.getUserMedia).toHaveBeenCalledWith({ video: true });
    await waitFor(() => expect(screen.getByText('Camera works.')).toBeTruthy());
    expect(media.tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Camera preview')).toBeNull();
  });

  it('a refusal in a browser says how to allow it from the address bar', async () => {
    const media = fakeMedia({ fail: 'NotAllowedError' });
    const { container } = render(<Wizard deps={testDeps()} devices={media.devices} initialStep={4} navigate={() => {}} />);
    press('Agree');
    press('Test microphone');
    await waitFor(() => expect(screen.getByText(/The browser is not letting this page use the microphone/)).toBeTruthy());
    expect(container.textContent).toContain('site icon to the left of the address bar');
    expect(container.textContent).not.toContain('Windows Settings');
  });

  it('a refusal in the desktop app says how to allow it in Windows privacy settings', async () => {
    await inTheApp();
    const media = fakeMedia({ fail: 'NotAllowedError' });
    const { container } = render(<Wizard deps={testDeps()} devices={media.devices} initialStep={4} navigate={() => {}} />);
    press('Agree');
    press('Test microphone');
    await waitFor(() => expect(screen.getByText(/Windows is not letting this app use the microphone/)).toBeTruthy());
    expect(container.textContent).toContain('Windows Settings, then Privacy & security, then Microphone');
    expect(container.textContent).toContain('Let desktop apps access your microphone');
    expect(container.textContent).not.toContain('address bar');
  });

  it('no microphone found says so', async () => {
    const media = fakeMedia({ fail: 'NotFoundError' });
    render(<Wizard deps={testDeps()} devices={media.devices} initialStep={4} navigate={() => {}} />);
    press('Agree');
    press('Test microphone');
    await waitFor(() => expect(screen.getByText('No microphone was found.')).toBeTruthy());
  });
});

describe('Wizard — finishing', () => {
  it('Start talking sets welcomed, saves it, and goes to /chat', () => {
    const deps = testDeps();
    const navigate = vi.fn();
    render(<Wizard deps={deps} initialStep={5} navigate={navigate} />);
    expect(saved(deps.storage).welcomed).toBe(false);
    press('Start talking');
    expect(saved(deps.storage).welcomed).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/chat');
  });

  it('Skip setup on the first step also sets welcomed and goes to /chat', () => {
    const deps = testDeps();
    const navigate = vi.fn();
    render(<Wizard deps={deps} navigate={navigate} />);
    press('Skip setup');
    expect(saved(deps.storage).welcomed).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/chat');
  });

  it('keeps every earlier choice when it finishes', () => {
    const deps = testDeps();
    render(<Wizard deps={deps} initialStep={2} navigate={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /Theo/ }));
    press('Next');
    fireEvent.click(screen.getByRole('radio', { name: /Don't remember/ }));
    press('Next');
    press('Skip for now');
    press('Start talking');
    expect(saved(deps.storage)).toMatchObject({ character: 'theo', memory: 'off', welcomed: true });
  });

  it('summarises the choices and links back to whatever was skipped', () => {
    const deps = testDeps();
    render(<Wizard deps={deps} initialStep={5} navigate={() => {}} />);
    expect(screen.getByText(/She cannot answer until you choose one/)).toBeTruthy();
    expect(screen.getByText('Text only for now.')).toBeTruthy();
    press('Choose a language model');
    expect(heading()).toBe('Choose a language model');
  });

  it('does not offer a link back for what was done', () => {
    const storage = memoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, llm: { endpoint: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3', temperature: null } }),
    );
    const consent = new ModelConsent(memoryStorage());
    consent.grant([AVATAR_DESCRIPTOR, ...browserModelsFor(DEFAULT_SETTINGS)]);
    render(<Wizard deps={testDeps({ storage, consent })} initialStep={5} navigate={() => {}} />);
    expect(screen.getByText('Ollama, llama3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose a language model' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show the character' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up voice' })).toBeNull();
  });
});
