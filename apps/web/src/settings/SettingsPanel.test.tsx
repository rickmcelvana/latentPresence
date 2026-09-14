import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import type { SettingsDeps } from './deps';
import { InMemoryMasterKeyPort, Vault } from './vault';
import { SettingsPanel } from './SettingsPanel';

afterEach(cleanup);

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
    ...overrides,
  };
}

function selectEndpoint(label: string): void {
  fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: optionValueFor(label) } });
}

/** The eight presets use their preset id as the option value; the label text alone does
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
