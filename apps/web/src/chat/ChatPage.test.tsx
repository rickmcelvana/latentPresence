import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import { FakeAvatarRenderer } from '@latentpresence/avatar';
import { replayFusion, type FusionRecording } from '@latentpresence/core';
import type { PlaybackEvent, PlaybackSink } from '@latentpresence/core';
import { faceModels, kokoroModel } from '@latentpresence/ml-web';
import { FakeTTSProvider } from '@latentpresence/providers';
import type { CancellationSignal, LLMProvider, LlmModel, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import type { MinimalCacheStorage } from '../consent/deps';
import type { SettingsDeps } from '../settings/deps';
import { InMemoryMasterKeyPort, Vault } from '../settings/vault';
import { SETTINGS_STORAGE_KEY } from '../settings/settings';
import { defaultPersona } from '../persona/default-persona';
import { CHAT_CHARACTER_NAME, ChatPage, type FaceReadingLoader, type SpeakerLoader } from './ChatPage';
import type { FaceReadingOptions } from '../call/face-reading';
import type { ChatLlmOptions } from './chat-llm';

afterEach(cleanup);

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** `CallStage`'s test seam (P2-T06): every test here renders the video-call layout, which
 * mounts a renderer for the stage behind the scenes. The real `VrmAvatarRenderer` needs
 * WebGL, which jsdom does not have — this fake keeps every test in this file exactly as
 * fast and network-free as it always was. */
function fakeCreateRenderer(): FakeAvatarRenderer {
  return new FakeAvatarRenderer();
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true });
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
    // Nothing has agreed to any model, which is what makes the voice test below reach the
    // consent screen rather than a download.
    consent: new ModelConsent(memoryStorage()),
    caches: {
      keys: async () => [],
      open: () => Promise.reject(new Error('not used in these tests')),
      delete: async () => false,
    } satisfies MinimalCacheStorage,
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

/** The system prompt a request carried, or '' when it carried none. */
function systemOf(request: LlmRequest | undefined): string {
  return request?.messages.find((message) => message.role === 'system')?.content ?? '';
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
    render(<ChatPage buildProvider={provider} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(seen.length).toBe(1));

    const system = seen[0]?.messages.find((message) => message.role === 'system');
    expect(system?.content).toContain('You are Alice.');
    expect(system?.content).toContain('[emote:curiosity]');
    expect(system?.content).toContain('nod, shake-head, shrug');
  });

  it('tells the model how she feels, from the tags she has written (P3-T09)', async () => {
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
        yield { type: 'text-delta', text: '[emote:sadness] Oh no. [emote:sadness] That is hard. [emote:sadness] I am sorry.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    });
    render(<ChatPage buildProvider={provider} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    const say = async (text: string, count: number) => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      await waitFor(() => expect(seen.length).toBe(count));
      await act(() => settle());
    };
    await say('my cat died', 1);
    // The engine takes a feeling on its next 100 ms step; a person's next turn is never sooner.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await say('she was nineteen', 2);

    expect(systemOf(seen[0])).toContain('settled, your usual self');
    expect(systemOf(seen[1])).toContain('and right now sad');
    // The persona part is untouched: only the last two lines move.
    expect(systemOf(seen[1]).split('\n').slice(0, -2)).toEqual(systemOf(seen[0]).split('\n').slice(0, -2));
  });

  it("tells the model how the user seems, from what they wrote, and shows it on the overlay (P3-T07)", async () => {
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
        yield { type: 'text-delta', text: '[user:angry] [emote:concern] That sounds maddening.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    });
    window.history.replaceState(null, '', '/chat?affect');
    try {
      // StrictMode, as `main.tsx` mounts it: its mount-time cleanup once stopped the overlay's
      // recorder for good, and the first live check copied an empty session.
      render(
        <StrictMode>
          <ChatPage buildProvider={provider} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />
        </StrictMode>,
      );
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'this is SO frustrating, nothing works!! 😡' } });
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      await waitFor(() => expect(seen.length).toBe(1));
      await act(() => settle());

      expect(systemOf(seen[0])).toContain('They seem frustrated (from what they wrote).');
      expect(screen.getByTestId('affect-overlay').textContent).toContain('told her: angry');

      const copied: string[] = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
      fireEvent.click(screen.getByRole('button', { name: 'Copy recording' }));
      await act(() => settle());
      const recording = JSON.parse(copied[0] ?? '{}') as FusionRecording;
      expect(recording.inputs.map((input) => input.kind)).toEqual(['turn', 'tag']);
      expect(replayFusion(recording).map((affect) => affect.label)).toEqual(['angry']);
    } finally {
      window.history.replaceState(null, '', '/');
    }
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
    render(<ChatPage buildProvider={provider} createRenderer={fakeCreateRenderer} deps={deps} />);
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
    render(<ChatPage buildProvider={provider} createRenderer={fakeCreateRenderer} deps={deps} />);
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

describe('ChatPage — voice (P1-T15)', () => {
  it('offers voice from a production route, and asks before anything downloads', async () => {
    // The whole of P1-T15 in one test: `/chat` is not a dev route, the button is there
    // without one, and the first thing behind it is the consent screen rather than a
    // download. The panel is a lazy chunk, so this also proves it resolves in a build that
    // is not the dev harness.
    const storage = memoryStorage();
    seedConfigured(storage);
    const deps = testDeps({ storage });
    render(<ChatPage buildProvider={scriptedProvider([])} createRenderer={fakeCreateRenderer} deps={deps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    // The panel itself is a lazy chunk: the second button only exists once it has loaded.
    await waitFor(() => expect(screen.getByText(/A browser voice and hearing/u)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agree' })).toBeTruthy());

    expect(deps.consent.granted()).toEqual([]);
    expect(screen.getByText(/Hugging Face/u)).toBeTruthy();
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
        <ChatPage buildProvider={provider} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />
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
    render(<ChatPage buildProvider={provider} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
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
    const { container } = render(<ChatPage createRenderer={fakeCreateRenderer} deps={deps} />);
    const textbox = screen.getByRole('textbox');

    fireEvent.change(textbox, { target: { value: 'hi' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await act(() => settle());

    expect(container.textContent).toContain('The language model failed:');
    expect(container.textContent).toContain('pnpm companion');
  });
});

describe('ChatPage — the call layout (P2-T06)', () => {
  const ORIGINAL_INNER_WIDTH = window.innerWidth;

  afterEach(() => {
    setViewportWidth(ORIGINAL_INNER_WIDTH);
  });

  it('the transcript drawer starts closed below 1440 px', () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const { container } = render(<ChatPage createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);

    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(true);
  });

  it('the transcript drawer starts open at 1440 px and up', () => {
    setViewportWidth(1440);
    const storage = memoryStorage();
    seedConfigured(storage);
    const { container } = render(<ChatPage createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);

    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(false);
  });

  it('the Transcript button toggles the drawer open and shut', () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const { container } = render(<ChatPage createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(true);
  });

  it('the Text button hides and shows the text box', () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    render(<ChatPage createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);

    expect(screen.getByRole('textbox')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('puts the text box away while the voice panel is open, and brings it back after', async () => {
    // R-14 (2026-09-23): both cards share the spot above the bar, and with the text box
    // showing, the voice panel's consent card was hidden behind it.
    const storage = memoryStorage();
    seedConfigured(storage);
    render(<ChatPage createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await waitFor(() => expect(screen.getByText(/A browser voice and hearing/u)).toBeTruthy());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'Text' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
  });

  it('Mute is disabled with no call running', () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    render(<ChatPage createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);

    expect((screen.getByRole('button', { name: 'Mute' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * A speaker with no audio graph (P2-T08). Every sentence starts playing as it is queued and
 * none ever ends, so an answer stays audible until something stops it — which is the state
 * Stop has to handle.
 */
function fakeSpeaker() {
  const log: string[] = [];
  const tts = new FakeTTSProvider('fake-tts', { msPerChar: 1 });
  const listeners = new Set<(event: PlaybackEvent) => void>();
  let playing: number | null = null;
  let ids = 0;
  const sink: PlaybackSink = {
    enqueue: () => {
      ids += 1;
      const id = ids;
      playing = id;
      queueMicrotask(() => {
        for (const listener of listeners) listener({ type: 'started', id, at: 0 });
      });
      return id;
    },
    duck: () => undefined,
    unduck: () => undefined,
    fadeOut: async (ms) => {
      log.push(`fade ${ms}`);
    },
    position: () => (playing === null ? null : { id: playing, frame: 0 }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const loader: SpeakerLoader = {
    voiceModelsFor: () => [kokoroModel('fp32')],
    start: async () => {
      log.push('start');
      return {
        voice: { tts, sink, voiceId: 'af_heart' },
        output: null,
        stop: async () => {
          log.push('stop');
        },
      };
    },
  };
  return { loadSpeaker: async () => loader, log, tts };
}

function speakButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Speak replies|Loading voice/u }) as HTMLButtonElement;
}

function speakRig(script: readonly LlmStreamChunk[] = [], consented = true) {
  const storage = memoryStorage();
  seedConfigured(storage);
  const deps = testDeps({ storage });
  if (consented) deps.consent.grant([kokoroModel('fp32')]);
  const speaker = fakeSpeaker();
  const view = render(
    <ChatPage buildProvider={scriptedProvider(script)} createRenderer={fakeCreateRenderer} deps={deps} loadSpeaker={speaker.loadSpeaker} />,
  );
  return { ...speaker, deps, view, button: speakButton };
}

async function type(text: string): Promise<void> {
  const textbox = screen.getByRole('textbox');
  fireEvent.change(textbox, { target: { value: text } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  await act(() => settle());
}

describe('ChatPage — Speak replies (P2-T08)', () => {
  it('asks for the voice alone before anything loads, where the text box was', async () => {
    const r = speakRig([], false);
    fireEvent.click(r.button());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agree' })).toBeTruthy());

    expect(r.log).toEqual([]);
    expect(r.deps.consent.granted()).toEqual([]);
    expect(screen.getByText(/Kokoro/u)).toBeTruthy();
    expect(screen.queryByText(/Silero/u)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
    expect(r.button().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(r.button());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agree' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Agree' }));
    await waitFor(() => expect(r.button().getAttribute('aria-pressed')).toBe('true'));
    expect(r.log).toEqual(['start']);
    expect(r.deps.consent.has([kokoroModel('fp32')])).toBe(true);
  });

  it('speaks a typed reply, and Stop cuts the voice as it cuts the text', async () => {
    const r = speakRig([
      { type: 'text-delta', text: 'Hello there. ' },
      { type: 'text-delta', text: 'How are you?' },
      { type: 'finish', reason: 'stop', usage: null },
    ]);
    fireEvent.click(r.button());
    await waitFor(() => expect(r.button().getAttribute('aria-pressed')).toBe('true'));

    await type('hi');
    await waitFor(() => expect(r.tts.requests.map((request) => request.text)).toContain('Hello there.'));
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(() => settle());
    expect(r.log).toContain('fade 100');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('turned off, it stops the speaker and the next reply is text', async () => {
    const r = speakRig([
      { type: 'text-delta', text: 'Plain.' },
      { type: 'finish', reason: 'stop', usage: null },
    ]);
    fireEvent.click(r.button());
    await waitFor(() => expect(r.button().getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(r.button());
    await act(() => settle());

    expect(r.log).toEqual(['start', 'stop']);
    expect(r.button().getAttribute('aria-pressed')).toBe('false');
    await type('hi');
    expect(r.tts.requests).toHaveLength(0);
  });

  it('ends when a call begins, since a call brings its own voice', async () => {
    const r = speakRig();
    fireEvent.click(r.button());
    await waitFor(() => expect(r.button().getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());

    expect(r.log).toEqual(['start', 'stop']);
    expect(r.button().disabled).toBe(true);
  });

  it('stops the speaker when the page goes', async () => {
    const r = speakRig();
    fireEvent.click(r.button());
    await waitFor(() => expect(r.button().getAttribute('aria-pressed')).toBe('true'));
    r.view.unmount();
    expect(r.log).toEqual(['start', 'stop']);
  });
});

/**
 * Face reading (P3-T06), with a fake camera and a fake face module: what the page does
 * before and after consent, and what turning it off turns off. The real worker, the real
 * camera and the network are `e2e/face.spec.ts`'s.
 */
function faceButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Read my face' });
}

function faceRig({ agreed = false }: { agreed?: boolean } = {}) {
  const storage = memoryStorage();
  seedConfigured(storage);
  const consent = new ModelConsent(memoryStorage());
  if (agreed) consent.grant(faceModels());
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
  const runs: FaceReadingOptions[] = [];
  const handle = { stop: vi.fn() };
  const loader: FaceReadingLoader = {
    faceReadingModels: () => faceModels(),
    startFaceReading: async (options) => {
      runs.push(options);
      return handle;
    },
  };
  const view = render(
    <ChatPage
      camera={{ getUserMedia }}
      createRenderer={fakeCreateRenderer}
      deps={testDeps({ storage, consent })}
      loadFaceReading={async () => loader}
    />,
  );
  return { view, button: faceButton, getUserMedia, runs, handle, track };
}

describe('ChatPage — face reading (P3-T06)', () => {
  it('asks first, and asking touches neither the camera nor the model', async () => {
    const r = faceRig();
    fireEvent.click(r.button());
    await screen.findByText('Read your expression from the camera?');
    expect(screen.getByText(/no frame is saved or sent anywhere/u)).toBeTruthy();
    expect(r.getUserMedia).not.toHaveBeenCalled();
    expect(r.runs).toHaveLength(0);

    // The character's own card has a "Not now" too; this is the face card's.
    const card = screen.getByText('Read your expression from the camera?').closest('section');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Not now' }));
    await act(() => settle());
    expect(screen.queryByText('Read your expression from the camera?')).toBeNull();
    expect(r.getUserMedia).not.toHaveBeenCalled();
    expect(r.button().getAttribute('aria-pressed')).toBe('false');
  });

  it('agreed, turns the camera on, reads its picture, and shows the light', async () => {
    const r = faceRig();
    fireEvent.click(r.button());
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on face reading' }));
    await waitFor(() => expect(r.runs).toHaveLength(1));
    expect(r.getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(r.runs[0]?.video).toBeInstanceOf(HTMLVideoElement);

    act(() => r.runs[0]?.onStatus({ reading: null, delegate: 'CPU', inferenceMs: 20 }));
    expect(screen.getByTestId('face-indicator').textContent).toContain('no face seen');
  });

  it('off turns off the camera it turned on', async () => {
    const r = faceRig({ agreed: true });
    fireEvent.click(r.button());
    await waitFor(() => expect(r.button().getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(r.runs).toHaveLength(1));
    fireEvent.click(r.button());
    await act(() => settle());
    expect(r.handle.stop).toHaveBeenCalled();
    expect(r.track.stop).toHaveBeenCalled();
    expect(screen.queryByTestId('face-indicator')).toBeNull();
  });

  it('leaves on a camera that was already on', async () => {
    const r = faceRig({ agreed: true });
    fireEvent.click(screen.getByRole('button', { name: 'Camera' }));
    await waitFor(() => expect(r.getUserMedia).toHaveBeenCalledTimes(1));
    fireEvent.click(r.button());
    await waitFor(() => expect(r.runs).toHaveLength(1));
    fireEvent.click(r.button());
    await act(() => settle());
    expect(r.handle.stop).toHaveBeenCalled();
    expect(r.track.stop).not.toHaveBeenCalled();
    expect(r.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('turning the camera off stops the reading, and the page going stops it too', async () => {
    const r = faceRig({ agreed: true });
    fireEvent.click(r.button());
    await waitFor(() => expect(r.runs).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Camera' }));
    await act(() => settle());
    expect(r.handle.stop).toHaveBeenCalledTimes(1);
    expect(r.button().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(r.button());
    await waitFor(() => expect(r.runs).toHaveLength(2));
    r.view.unmount();
    expect(r.handle.stop).toHaveBeenCalledTimes(2);
  });

  it('a refused camera ends it, with the reason where the picture would be', async () => {
    const r = faceRig({ agreed: true });
    r.getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
    fireEvent.click(r.button());
    await screen.findByText('Camera: Permission denied');
    expect(r.button().getAttribute('aria-pressed')).toBe('false');
    expect(r.runs).toHaveLength(0);
  });
});
