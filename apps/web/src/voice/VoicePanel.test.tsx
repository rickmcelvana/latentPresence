import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationMachine, attachHistory } from '@latentpresence/core';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import { FakeSTTProvider, FakeTTSProvider } from '@latentpresence/providers';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import type { CancellationSignal, LLMProvider, LlmModel, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import type { MinimalCacheStorage } from '../consent/deps';
import type { SettingsDeps } from '../settings/deps';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings';
import { InMemoryMasterKeyPort, Vault } from '../settings/vault';
import { VoicePanel, type ActiveCall, type VoicePanelProps } from './VoicePanel';
import { browserModelsFor } from './models';
import type { SpeechProviders } from './providers';

afterEach(cleanup);

/**
 * The panel is where P1-T15's promise is made or broken: **nothing downloads before the
 * screen is agreed to, and the choice in `/settings` is the list on that screen.** Both are
 * asserted here against a `startCall` that never opens an audio graph, because the
 * alternative is a jsdom Web Audio implementation that does not exist.
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

function testDeps(): SettingsDeps {
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
    caches: {
      keys: async () => [],
      open: () => Promise.reject(new Error('not used in these tests')),
      delete: async () => false,
    } satisfies MinimalCacheStorage,
  };
}

function fakeLlm(): LLMProvider {
  return {
    id: 'fake',
    async listModels(): Promise<LlmModel[]> {
      return [];
    },
    async *stream(_request: LlmRequest, _options?: { signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
      yield { type: 'finish', reason: 'stop', usage: null };
    },
  };
}

/**
 * A voice and a hearing with no model behind them.
 *
 * The panel is tested against this rather than the real builder because the real one
 * refuses a browser with no WebGPU — which jsdom is — and because what this file is about
 * is the consent gate and the panel's states, not which adapter `/settings` chose. That
 * belongs to `providers.test.ts`.
 */
function fakeSpeech(): SpeechProviders {
  return {
    tts: new FakeTTSProvider('fake-tts', { msPerChar: 1 }),
    stt: new FakeSTTProvider(),
    dispose: () => undefined,
  };
}

function harness(overrides: Partial<VoicePanelProps> = {}) {
  const machine = new ConversationMachine({ sessionId: 'chat', characterId: 'alice' });
  machine.start();
  const { history } = attachHistory(machine, { system: null });
  const deps = testDeps();
  const stopped: string[] = [];
  const startCall = vi.fn(
    async (): Promise<ActiveCall> => ({
      inputLabel: 'Test microphone',
      stop: async () => {
        stopped.push('stop');
      },
    }),
  );
  const onActive = vi.fn();
  const onEnd = vi.fn();
  const settings: Settings = DEFAULT_SETTINGS;
  const props: VoicePanelProps = {
    machine,
    history,
    llm: fakeLlm(),
    modelId: 'test-model',
    temperature: null,
    settings,
    deps,
    onActive,
    onEnd,
    startCall,
    buildSpeech: async () => fakeSpeech(),
    ...overrides,
  };
  return { props, deps, startCall, onActive, onEnd, stopped, machine };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe('VoicePanel — consent before download', () => {
  it('shows the consent screen instead of starting, and lists what this browser will fetch', () => {
    const { props, startCall } = harness();
    render(<VoicePanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));

    expect(startCall).not.toHaveBeenCalled();
    for (const model of browserModelsFor(DEFAULT_SETTINGS)) {
      expect(screen.getByText(model.label)).toBeTruthy();
    }
    // The screen says where the bytes come from, which is the licence-and-source half of
    // CLAUDE.md's rule.
    expect(screen.getByText(/Hugging Face/u)).toBeTruthy();
  });

  it('records consent for exactly those models when Agree is pressed, then starts', async () => {
    const { props, deps, startCall } = harness();
    render(<VoicePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agree' }));
    await act(() => settle());

    const expected = browserModelsFor(DEFAULT_SETTINGS).map((model) => model.id);
    expect([...deps.consent.granted()].toSorted()).toEqual(expected.toSorted());
    expect(startCall).toHaveBeenCalledTimes(1);
  });

  it('downloads nothing and reports the cancel', () => {
    const { props, deps, startCall, onEnd } = harness();
    render(<VoicePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(deps.consent.granted()).toEqual([]);
    expect(startCall).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('skips the screen when every model has already been agreed to', async () => {
    const { props, deps, startCall } = harness();
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    render(<VoicePanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());

    expect(screen.queryByRole('button', { name: 'Agree' })).toBeNull();
    expect(startCall).toHaveBeenCalledTimes(1);
  });

  it('asks again after /settings revokes consent', () => {
    const { props, deps, startCall } = harness();
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    deps.consent.revoke();
    render(<VoicePanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));

    expect(screen.getByRole('button', { name: 'Agree' })).toBeTruthy();
    expect(startCall).not.toHaveBeenCalled();
  });
});

describe('VoicePanel — the call', () => {
  it('goes active once the call exists, and takes the keyboard away on /chat', async () => {
    const { props, deps, onActive } = harness();
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    render(<VoicePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());

    expect(screen.getByRole('button', { name: 'End call' })).toBeTruthy();
    expect(screen.getByText(/Listening on Test microphone/u)).toBeTruthy();
    expect(onActive).toHaveBeenLastCalledWith(true);
  });

  it('keeps the call running when the parent re-renders with a new callback identity', async () => {
    // **The bug this test exists for reached Rick on a real machine** (2026-09-22): `/chat`
    // passed `onActive` as an inline arrow, so every re-render gave it a new identity, the
    // unmount effect's dependency changed, React ran the cleanup — and the cleanup stops the
    // call. The panel still said "Listening on <microphone>" with the phase still `active`,
    // so it looked connected while the VAD, the capture and the audio graph had all been
    // torn down: the microphone was shown and nothing was ever heard. `/dev/voice` had no
    // such bug because the harness owns its pipeline outside React's dependency graph.
    //
    // A prop changing identity is not a reason to end a call, so the panel must not treat it
    // as one. Every previous test here passed because `harness()` hands over one stable
    // `vi.fn()` — the seam hid the defect, which is why this test re-renders with a *new*
    // function rather than asserting on the one it started with.
    const { props, deps, stopped } = harness();
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    const { rerender } = render(<VoicePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());
    expect(stopped).toEqual([]);

    rerender(<VoicePanel {...props} onActive={vi.fn()} />);
    await act(() => settle());
    rerender(<VoicePanel {...props} onActive={vi.fn()} onEnd={vi.fn()} />);
    await act(() => settle());

    expect(stopped).toEqual([]);
    expect(screen.getByRole('button', { name: 'End call' })).toBeTruthy();
  });

  it('ends the call and leaves voice mode', async () => {
    const { props, deps, onActive, onEnd, stopped } = harness();
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    render(<VoicePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());
    fireEvent.click(screen.getByRole('button', { name: 'End call' }));
    await act(() => settle());

    expect(stopped).toEqual(['stop']);
    expect(onActive).toHaveBeenLastCalledWith(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('shows the failure and offers Start again when the call cannot be built', async () => {
    const startCall = vi.fn(async (): Promise<ActiveCall> => {
      throw new Error('silero-vad: no WebGPU adapter');
    });
    const { props, deps, onActive } = harness({ startCall });
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    render(<VoicePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());

    expect(screen.getByText('silero-vad: no WebGPU adapter')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start voice' })).toBeTruthy();
    // Never announced as active: `/chat` must not disable its own text box for a call that
    // does not exist.
    expect(onActive).not.toHaveBeenCalledWith(true);
  });

  it('stops a running call when the panel is unmounted', async () => {
    const { props, deps, stopped, onEnd } = harness();
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    const { unmount } = render(<VoicePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());

    unmount();
    await waitFor(() => expect(stopped).toEqual(['stop']));
    // Unmounting is not the same as pressing End call: the caller is not told to leave voice
    // mode by a teardown that is already happening.
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('survives StrictMode, whose mount-time cleanup runs before any call exists', async () => {
    const { props, deps } = harness();
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    render(
      <StrictMode>
        <VoicePanel {...props} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());

    expect(screen.getByRole('button', { name: 'End call' })).toBeTruthy();
  });

  it('shows the machine state, so a person can see it listening', async () => {
    const { props, deps, machine } = harness();
    deps.consent.grant(browserModelsFor(DEFAULT_SETTINGS));
    render(<VoicePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());

    // `machine.start()` puts it in `listening` before a call exists (P1-T11), so that is
    // what the pill says on the way in.
    expect(screen.getByText('listening')).toBeTruthy();
    act(() => {
      machine.dispatch({ type: 'user.turn.ended', probability: null, sessionId: 'chat', at: new Date().toISOString() });
    });
    expect(screen.getByText('thinking')).toBeTruthy();
  });
});
