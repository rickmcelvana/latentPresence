import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CancellationSignal, LLMProvider, LlmModel, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import type { SettingsDeps } from '../settings/deps';
import { InMemoryMasterKeyPort, Vault } from '../settings/vault';
import { SETTINGS_STORAGE_KEY } from '../settings/settings';
import { defaultPersona } from '../persona/default-persona';
import { CHAT_CHARACTER_NAME, ChatPage } from './ChatPage';
import type { ChatLlmOptions } from './chat-llm';

afterEach(cleanup);

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

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

function seedConfigured(storage: Storage, llm: Partial<{ endpoint: string; baseUrl: string; modelId: string; temperature: number | null }> = {}): void {
  storage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      companionUrl: 'http://127.0.0.1:8787',
      llm: { endpoint: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3', temperature: null, ...llm },
      tts: { kind: 'kokoro-browser', voiceId: 'af_heart', speed: 1 },
      stt: { kind: 'moonshine-browser', model: 'moonshine-tiny' },
    }),
  );
}

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

/** A provider `/chat` can be built with directly, bypassing the network — the "injected
 * provider" the brief asks the page tests use for everything but the transport-failure
 * case, which drives the real `chatLlmProvider`. */
function scriptedProvider(
  script: readonly LlmStreamChunk[],
  gate?: { promise: Promise<void>; after: number },
): (options: ChatLlmOptions) => LLMProvider {
  return () => ({
    id: 'fake',
    async listModels(): Promise<LlmModel[]> {
      return [];
    },
    async *stream(_request: LlmRequest, options?: { signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
      for (const [i, chunk] of script.entries()) {
        if (gate !== undefined && i === gate.after) await gate.promise;
        if (options?.signal?.aborted === true) return;
        yield chunk;
      }
    },
  });
}

describe('ChatPage — the persona', () => {
  it('sends the persona as a system prompt, with the tag rules in it', async () => {
    // The whole of P1-T12 reaches a model through this one field. Before 67dd675 a
    // `system` message threw before the request, so "it is set" is worth asserting on
    // the request the provider actually receives rather than on the page's props.
    const storage = memoryStorage();
    seedConfigured(storage);
    const seen: LlmRequest[] = [];
    const provider = (): LLMProvider => ({
      id: 'fake',
      async listModels(): Promise<LlmModel[]> {
        return [];
      },
      async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
        seen.push(request);
        yield { type: 'text-delta', text: 'Hi.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    });
    render(<ChatPage buildProvider={provider} deps={testDeps({ storage })} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(seen.length).toBe(1));

    const system = seen[0]?.messages.find((message) => message.role === 'system');
    expect(system?.content).toContain('You are Alice.');
    expect(system?.content).toContain('[emote:curiosity]');
    expect(system?.content).toContain('nod, shake-head, shrug');
  });

  it('names the character from the persona file rather than a constant', () => {
    expect(CHAT_CHARACTER_NAME).toBe(defaultPersona.name);
  });
});

describe('ChatPage — unconfigured', () => {
  it('shows a link to Settings and no text box', () => {
    const storage = memoryStorage();
    render(<ChatPage deps={testDeps({ storage })} />);
    expect(screen.getByRole('link', { name: /Settings/ })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('ChatPage — the text box', () => {
  it('Enter sends; Shift+Enter does not', async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    const deps = testDeps({ storage });
    const provider = scriptedProvider([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'finish', reason: 'stop', usage: null },
    ]);
    render(<ChatPage buildProvider={provider} deps={deps} />);
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textbox, { target: { value: 'hello' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });
    expect(textbox.value).toBe('hello');

    fireEvent.keyDown(textbox, { key: 'Enter' });
    await act(() => settle());

    expect(textbox.value).toBe('');
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('Stop appears while an answer streams, and stops it', async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    const deps = testDeps({ storage });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = scriptedProvider(
      [
        { type: 'text-delta', text: 'Half ' },
        { type: 'text-delta', text: 'the answer.' },
        { type: 'finish', reason: 'stop', usage: null },
      ],
      { promise: gate, after: 1 },
    );
    render(<ChatPage buildProvider={provider} deps={deps} />);
    const textbox = screen.getByRole('textbox');

    fireEvent.change(textbox, { target: { value: 'go' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await act(() => settle());

    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(() => settle());

    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    release();
    await act(() => settle());
  });
});

describe('ChatPage — as main.tsx mounts it', () => {
  it('still answers under StrictMode, whose mount-time cleanup must not end the session', async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    const provider = scriptedProvider([
      { type: 'text-delta', text: 'Still here.' },
      { type: 'finish', reason: 'stop', usage: null },
    ]);
    render(
      <StrictMode>
        <ChatPage buildProvider={provider} deps={testDeps({ storage })} />
      </StrictMode>,
    );
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'are you there' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await act(() => settle());
    expect(screen.getByText('Still here.')).toBeTruthy();
  });

  it('offers Stop as soon as a message is sent, before the model says anything', async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = scriptedProvider([{ type: 'text-delta', text: 'Late.' }, { type: 'finish', reason: 'stop', usage: null }], { promise: gate, after: 0 });
    render(<ChatPage buildProvider={provider} deps={testDeps({ storage })} />);
    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'go' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    release();
    await act(() => settle());
  });
});

describe('ChatPage — transport failure', () => {
  it('a relay endpoint with the companion down shows the notice', async () => {
    const storage = memoryStorage();
    seedConfigured(storage, { endpoint: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1' });
    const deps = testDeps({ storage, probe: async (): Promise<EndpointProbe> => ({ kind: 'unreachable' }) });
    // No `buildProvider` override: the real `chatLlmProvider` runs, so `resolveTransport`
    // really executes against the stubbed `probe`.
    const { container } = render(<ChatPage deps={deps} />);
    const textbox = screen.getByRole('textbox');

    fireEvent.change(textbox, { target: { value: 'hi' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await act(() => settle());

    expect(container.textContent).toContain('The language model failed:');
    expect(container.textContent).toContain('pnpm companion');
  });
});
