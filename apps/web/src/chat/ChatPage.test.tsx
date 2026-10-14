import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import { FakeAvatarRenderer, type Displays } from '@latentpresence/avatar';
import { EXTRACTION_SYSTEM, FakeMemoryStore, INNER_MARKER, replayFusion, type FusionRecording } from '@latentpresence/core';
import type { PlaybackEvent, PlaybackSink } from '@latentpresence/core';
import { faceModels, kokoroModel } from '@latentpresence/ml-web';
import { FakeTTSProvider } from '@latentpresence/providers';
import { FakeMcpServer, textResult } from '@latentpresence/providers/web';
import type { CancellationSignal, LLMProvider, LlmModel, LlmRequest, LlmStreamChunk, Schedule } from '@latentpresence/protocol';
import type { EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import type { MinimalCacheStorage } from '../consent/deps';
import type { SettingsDeps } from '../settings/deps';
import { InMemoryMasterKeyPort, Vault } from '../settings/vault';
import { SETTINGS_STORAGE_KEY } from '../settings/settings';
import { defaultPersona } from '../persona/default-persona';
import { CHAT_CHARACTER_NAME, ChatPage, type ChatPageProps, type FaceReadingLoader, type SpeakerLoader } from './ChatPage';
import type { FaceReadingOptions } from '../call/face-reading';
import type { ChatLlmOptions } from './chat-llm';
import { connectDocuments } from './chat-documents';
import type { NotificationPermissionState, PageNotifications } from './notifications';
import { InMemoryBodyShelf } from '../characters/body-shelf';
import { ALICE_GENERATED, ALICE_GENERATED_DESCRIPTOR, AVATAR_DESCRIPTOR } from '../call/character-asset';
import type { BodyReport } from '@latentpresence/avatar/vrm';

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

/** A stage that records what the room's whiteboard and screen were told to show (P5-T08). */
class DisplayRenderer extends FakeAvatarRenderer {
  readonly shown: Displays[] = [];
  setDisplays(displays: Displays): void {
    this.shown.push(displays);
  }
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

/** The system prompt without its last two lines (the mood) and the clock line. */
function withoutMoodOrClock(request: LlmRequest | undefined): string[] {
  return systemOf(request)
    .split('\n')
    .slice(0, -2)
    .filter((line) => !line.startsWith('- It is '));
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
    // The persona part is untouched: only the last two lines move — and the clock, which
    // crossed a minute between the two turns once on CI (2026-10-10).
    expect(withoutMoodOrClock(seen[1])).toEqual(withoutMoodOrClock(seen[0]));
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

  it('tells the model what she remembers, and remembers the exchange under a session of its own (P4-T04b)', async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    const store = new FakeMemoryStore();
    await store.upsertFact({
      id: 'f1',
      characterId: defaultPersona.id,
      subject: 'user',
      predicate: 'sister_name',
      object: 'Priya',
      confidence: 0.9,
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: null,
      recordedAt: '2026-09-01T00:00:00.000Z',
      sourceEpisodeId: null,
      embedding: null,
    });
    const chats: LlmRequest[] = [];
    const provider = (): LLMProvider => ({
      id: 'fake',
      async listModels(): Promise<LlmModel[]> {
        return [];
      },
      async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
        // The same model reads facts out of each exchange (ADR-37); only the chat is asserted on.
        if (systemOf(request).includes('You are Alice.')) chats.push(request);
        yield { type: 'text-delta', text: request.reasoning === 'off' ? '{"facts":[],"ended":[]}' : 'Hi.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    });
    const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
    const visit = async () => {
      const page = render(<ChatPage buildProvider={provider} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
      await waitFor(() => expect(store.calls).toContain('currentFacts'));
      await act(() => settle());
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello again' } });
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      await waitFor(() => expect(store.rows.episodes.filter(({ episode }) => episode.role === 'assistant')).toHaveLength(chats.length));
      page.unmount();
    };
    await visit();
    await visit();

    expect(systemOf(chats[0])).toContain('WHAT YOU REMEMBER ABOUT THEM');
    expect(systemOf(chats[0])).toContain('user sister name Priya');
    const sessions = new Set(store.rows.episodes.map(({ episode }) => episode.sessionId));
    expect(store.rows.episodes.map(({ episode }) => [episode.role, episode.text])).toEqual([
      ['user', 'hello again'],
      ['assistant', 'Hi.'],
      ['user', 'hello again'],
      ['assistant', 'Hi.'],
    ]);
    expect(sessions.size).toBe(2);
  });

  it('carries her mood to the next visit, and a note she writes into her next prompt (P4-T06)', async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    const store = new FakeMemoryStore();
    const chats: LlmRequest[] = [];
    let wroteNote = false;
    const provider = (): LLMProvider => ({
      id: 'fake',
      async listModels(): Promise<LlmModel[]> {
        return [];
      },
      async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
        if (request.reasoning === 'off') {
          yield { type: 'text-delta', text: '{"facts":[],"ended":[]}' };
          yield { type: 'finish', reason: 'stop', usage: null };
          return;
        }
        chats.push(request);
        if (!wroteNote && request.tools.some((tool) => tool.name === 'self_write_block')) {
          wroteNote = true;
          yield { type: 'tool-call', call: { id: 'c1', name: 'self_write_block', arguments: { name: 'how_they_talk', content: 'Short answers, please.' }, source: 'llm', requestedAt: '2026-09-28T00:00:00.000Z' } };
          yield { type: 'finish', reason: 'tool-calls', usage: null };
          return;
        }
        yield { type: 'text-delta', text: '[emote:sadness] Oh no. [emote:sadness] That is hard. [emote:sadness] I am sorry.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    });
    const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
    const visit = async (messages: readonly string[]) => {
      const page = render(<ChatPage buildProvider={provider} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
      await waitFor(() => expect(store.calls).toContain('currentFacts'));
      await act(() => settle());
      for (const text of messages) {
        const before = chats.length;
        fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
        await waitFor(() => expect(chats.length).toBeGreaterThan(before));
        await act(() => settle());
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await waitFor(async () => expect((await store.readBlocks(defaultPersona.id)).some((block) => block.name === '_mood')).toBe(true));
      page.unmount();
      await act(() => settle());
    };
    await visit(['my cat died', 'she was nineteen']);
    const firstOfSecondVisit = chats.length;
    await visit(['hello again']);

    const second = systemOf(chats[firstOfSecondVisit]);
    expect(second).toContain('right now sad');
    expect(second).toContain('YOUR OWN NOTES');
    expect(second).toContain('how they talk: Short answers, please.');
  });

  it('a plan she saves with plan_create is in the store and in the Plans panel (P4-T07)', async () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const store = new FakeMemoryStore();
    const chats: LlmRequest[] = [];
    let created = false;
    const provider = (): LLMProvider => ({
      id: 'fake',
      async listModels(): Promise<LlmModel[]> {
        return [];
      },
      async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
        if (request.reasoning === 'off') {
          yield { type: 'text-delta', text: '{"facts":[],"ended":[]}' };
          yield { type: 'finish', reason: 'stop', usage: null };
          return;
        }
        chats.push(request);
        if (!created && request.tools.some((tool) => tool.name === 'plan_create')) {
          created = true;
          const phases = [
            { title: 'Prepare the bed', tasks: ['Pick a sunny spot', 'Dig in compost'] },
            { title: 'Plant', tasks: ['Buy seedlings'] },
          ];
          yield { type: 'tool-call', call: { id: 'c1', name: 'plan_create', arguments: { title: 'Vegetable garden', goal: 'Easy vegetables by spring.', phases }, source: 'llm', requestedAt: '2026-09-30T00:00:00.000Z' } };
          yield { type: 'finish', reason: 'tool-calls', usage: null };
          return;
        }
        yield { type: 'text-delta', text: 'There is your plan.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    });
    const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
    const stage = new DisplayRenderer();
    render(<ChatPage buildProvider={provider} chooseMemory={chooseMemory} createRenderer={() => stage} deps={testDeps({ storage })} />);
    await waitFor(() => expect(store.calls).toContain('currentFacts'));
    await act(() => settle());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: "let's plan a vegetable garden" } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(async () => expect((await store.listPlans(defaultPersona.id))[0]?.title).toBe('Vegetable garden'));
    await waitFor(() => expect(chats.length).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    const row = await screen.findByRole('button', { name: /Vegetable garden/ });
    expect(row.textContent).toContain('0 of 3 done');
    expect(row.textContent).toContain('working on it now');

    // The plan in focus is on the room's whiteboard (P5-T08, ADR-49).
    const whiteboard = stage.shown.at(-1)?.whiteboard;
    expect(whiteboard?.title).toBe('Vegetable garden');
    expect(whiteboard?.lines.map((line) => line.text)).toEqual(['Prepare the bed', 'Pick a sunny spot', 'Dig in compost', 'Plant', 'Buy seedlings']);
  });

  it('speaks first when they come back after an hour or more, not after a reload within it, and never when Speaking up is off (P6-T02, P6-T03)', async () => {
    const visit = async (lastSpokeMsAgo: number, initiative: 'off' | 'normal' = 'normal') => {
      const storage = memoryStorage();
      seedConfigured(storage);
      const seeded = JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...seeded, initiative }));
      const store = new FakeMemoryStore();
      const at = new Date(Date.now() - lastSpokeMsAgo).toISOString();
      await store.appendEpisode({ id: 'e1', sessionId: 'earlier', characterId: defaultPersona.id, role: 'user', text: "I'll know the travel dates by Friday.", interrupted: false, at, embedding: null, affect: null });
      const chats: LlmRequest[] = [];
      const provider = (): LLMProvider => ({
        id: 'fake',
        async listModels(): Promise<LlmModel[]> {
          return [];
        },
        async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
          if (request.reasoning === 'off') {
            yield { type: 'text-delta', text: '{"facts":[],"ended":[]}' };
          } else {
            chats.push(request);
            yield { type: 'text-delta', text: 'Good to see you! Did the dates work out?' };
          }
          yield { type: 'finish', reason: 'stop', usage: null };
        },
      });
      const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
      const page = render(<ChatPage buildProvider={provider} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
      await waitFor(() => expect(store.calls).toContain('listEpisodes'));
      await act(() => settle());
      return { page, chats };
    };

    const back = await visit(2 * 3_600_000);
    await waitFor(() => expect(back.chats).toHaveLength(1));
    expect(back.chats[0]?.messages.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('you speak first') });
    expect(systemOf(back.chats[0])).toContain('YOU SPEAK FIRST');
    expect(systemOf(back.chats[0])).toContain('They said: "I\'ll know the travel dates by Friday."');
    expect(await screen.findByText('Good to see you! Did the dates work out?')).toBeTruthy();
    // The cue is never a line of theirs.
    expect(screen.queryByText(/you speak first/)).toBeNull();
    back.page.unmount();

    const reload = await visit(10 * 60_000);
    expect(reload.chats).toHaveLength(0);
    reload.page.unmount();

    // P6-T03 (ADR-52): Settings → Speaking up → Never turns the opener off too.
    const off = await visit(2 * 3_600_000, 'off');
    expect(off.chats).toHaveLength(0);
    off.page.unmount();
  });

  it('names the character from the persona file rather than a constant', () => {
    expect(CHAT_CHARACTER_NAME).toBe(defaultPersona.name);
  });
});

/** A model for the schedules tests: records the chat requests, answers the extractor with no facts. */
function schedulingModel(script: (request: LlmRequest, round: number) => LlmStreamChunk[] | null = () => null) {
  const chats: LlmRequest[] = [];
  const build = (): LLMProvider => ({
    id: 'fake',
    async listModels(): Promise<LlmModel[]> {
      return [];
    },
    async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
      if (request.reasoning === 'off') {
        yield { type: 'text-delta', text: '{"facts":[],"ended":[]}' };
        yield { type: 'finish', reason: 'stop', usage: null };
        return;
      }
      chats.push(request);
      const scripted = script(request, chats.length);
      if (scripted !== null) {
        yield* scripted;
        return;
      }
      yield { type: 'text-delta', text: 'Of course.' };
      yield { type: 'finish', reason: 'stop', usage: null };
    },
  });
  return { chats, build };
}

/** A schedule as the scheduler would leave it: a reminder due a minute ago, run, waiting to be told. */
function toldLater(overrides: Partial<Schedule> = {}): Schedule {
  const due = new Date(Date.now() - 60_000).toISOString();
  return {
    id: 'vet',
    characterId: defaultPersona.id,
    description: 'call the vet',
    trigger: { kind: 'once', at: due },
    taskPrompt: '',
    allowedTools: [],
    delivery: 'notify',
    catchUp: 'run_once',
    runOn: 'core',
    status: 'completed',
    lastRunAt: due,
    nextRunAt: null,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    toolCall: null,
    lastRun: { id: 'run-1', scheduleId: 'vet', startedAt: due, finishedAt: due, outcome: 'ok', summary: 'call the vet', error: null, scheduledFor: due, deliveredAt: null },
    ...overrides,
  };
}

describe('ChatPage — schedules (P6-T08, ADR-58)', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  it('the Schedules view lists what is scheduled, with the next run in words', async () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const store = new FakeMemoryStore();
    const next = new Date(Date.now() + 2 * 3_600_000).toISOString();
    await store.saveSchedule(toldLater({ id: 'later', description: 'water the plants', status: 'active', trigger: { kind: 'once', at: next }, nextRunAt: next, lastRun: null, lastRunAt: null }));
    const { build } = schedulingModel();
    const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
    render(<ChatPage buildProvider={build} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} notifications={fakeNotifications('granted').notifications} />);
    await act(() => settle());

    const button = screen.getByRole('button', { name: 'Schedules' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const item = (await screen.findByText('water the plants')).closest('li');
    expect(item?.textContent).toMatch(/\(in 2 hours\)/);
    expect(item?.textContent).toContain('once');
    // Pressing it again closes the drawer, as the others do.
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('says schedules need memory when memory is off', async () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const { build } = schedulingModel();
    render(<ChatPage buildProvider={build} chooseMemory={async () => null} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    await act(() => settle());
    fireEvent.click(screen.getByRole('button', { name: 'Schedules' }));
    expect(screen.getByText(/Schedules are kept with memory — memory is off\./)).toBeTruthy();
  });

  it('a run waiting to be told makes the first request carry the delivery cue, and no opener', async () => {
    setViewportWidth(1024);
    expect(document.visibilityState).toBe('visible');
    const storage = memoryStorage();
    seedConfigured(storage);
    const store = new FakeMemoryStore();
    // They last spoke three hours ago: without the reminder, she would open.
    await store.appendEpisode({ id: 'e1', sessionId: 'earlier', characterId: defaultPersona.id, role: 'user', text: 'Hello again.', interrupted: false, at: new Date(Date.now() - 3 * 3_600_000).toISOString(), embedding: null, affect: null });
    await store.saveSchedule(toldLater());
    const { chats, build } = schedulingModel();
    const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
    render(<ChatPage buildProvider={build} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} notifications={fakeNotifications('granted').notifications} />);
    await waitFor(() => expect(chats).toHaveLength(1));
    const cue = chats[0]?.messages.at(-1)?.content ?? '';
    expect(cue).toContain('They asked you to remind them about this');
    expect(cue).toContain('"call the vet"');
    expect(cue).not.toContain('you speak first');
    expect(await screen.findByText('Of course.')).toBeTruthy();
    // The cue is never a line of theirs, and she said it once: the run is now told.
    expect(screen.queryByText(/remind them about this/)).toBeNull();
    await waitFor(async () => expect((await store.listSchedules(defaultPersona.id))[0]?.lastRun?.deliveredAt).not.toBeNull());
    await act(() => settle());
    expect(chats).toHaveLength(1);
  });

  it('with the page hidden and notifications allowed, the run is a notification and she says nothing', async () => {
    setViewportWidth(1024);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      const storage = memoryStorage();
      seedConfigured(storage);
      const store = new FakeMemoryStore();
      await store.saveSchedule(toldLater());
      const { chats, build } = schedulingModel();
      const { notifications, shown } = fakeNotifications('granted');
      const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
      render(<ChatPage buildProvider={build} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} notifications={notifications} />);
      await waitFor(() => expect(shown).toEqual([[defaultPersona.name, 'call the vet', 'run-1']]));
      await waitFor(async () => expect((await store.listSchedules(defaultPersona.id))[0]?.lastRun?.deliveredAt).not.toBeNull());
      await act(() => settle());
      expect(chats).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('she can make one: schedule_create with a time worked out from now saves it, reads the time back, and the panel shows it', async () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const store = new FakeMemoryStore();
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 24 * 3_600_000));
    const { chats, build } = schedulingModel((request, round) =>
      round === 1 && request.tools.some((tool) => tool.name === 'schedule_create')
        ? [
            { type: 'tool-call', call: { id: 'c1', name: 'schedule_create', arguments: { description: 'call the vet', at: `${tomorrow}T09:00` }, source: 'llm', requestedAt: new Date().toISOString() } },
            { type: 'finish', reason: 'tool-calls', usage: null },
          ]
        : null,
    );
    const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
    render(<ChatPage buildProvider={build} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} notifications={fakeNotifications('granted').notifications} />);
    await waitFor(() => expect(store.calls).toContain('currentFacts'));
    await act(() => settle());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'remind me tomorrow at 9 to call the vet' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(async () => expect((await store.listSchedules(defaultPersona.id))[0]?.description).toBe('call the vet'));
    await waitFor(() => expect(chats.length).toBeGreaterThan(1));
    // The tool's reply, which she reads back from, carries the code's words for the time.
    const reply = JSON.stringify(chats.at(-1)?.messages.filter((message) => message.role === 'tool').map((message) => message.content));
    expect(reply).toContain('"when"');
    expect(reply).toMatch(/at 09:00 \(in /);
    // Her schedule tools are hers: not shown as a tool call in the transcript.
    expect(screen.queryByText(/schedule_create/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Schedules' }));
    const item = (await screen.findByText('call the vet')).closest('li');
    expect(item?.textContent).toMatch(/at 09:00 \(in /);
  });

  it('a store that keeps no schedules gives her no schedule tools', async () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const store = new FakeMemoryStore();
    store.capabilities = async () => ({ vectorSearch: true, dimensions: null, bitemporalFacts: true, plans: true, schedules: false, remote: false });
    const { chats, build } = schedulingModel();
    const chooseMemory = async () => ({ store, kind: 'browser' as const, reason: 'a test store' });
    render(<ChatPage buildProvider={build} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    await waitFor(() => expect(store.calls).toContain('currentFacts'));
    await act(() => settle());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(chats.length).toBeGreaterThan(0));
    const names = chats[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain('plan_create');
    expect(names.some((name) => name.startsWith('schedule_'))).toBe(false);
  });
});

/** The browser's notifications as the page sees them, recording what it was asked to show. */
function fakeNotifications(state: NotificationPermissionState) {
  const shown: [string, string, string][] = [];
  const notifications: PageNotifications = {
    permission: () => state,
    request: async () => state,
    show: async (title, body, tag) => {
      shown.push([title, body, tag]);
      return true;
    },
  };
  return { notifications, shown };
}

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

  it('Memory and Transcript switch the drawer between views, each pressed only while its own view shows (P4-T05)', () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const { container } = render(<ChatPage createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    const transcriptBtn = screen.getByRole('button', { name: 'Transcript' });
    const memoryBtn = screen.getByRole('button', { name: 'Memory' });

    // Closed at the start (below 1440 px): neither button is pressed.
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(true);
    expect(transcriptBtn.getAttribute('aria-pressed')).toBe('false');
    expect(memoryBtn.getAttribute('aria-pressed')).toBe('false');

    // Memory opens the drawer on the memory view.
    fireEvent.click(memoryBtn);
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('.memory-panel')).toBeTruthy();
    expect(memoryBtn.getAttribute('aria-pressed')).toBe('true');
    expect(transcriptBtn.getAttribute('aria-pressed')).toBe('false');

    // Transcript switches the open drawer to the transcript view rather than closing it.
    fireEvent.click(transcriptBtn);
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('.transcript-panel')).toBeTruthy();
    expect(container.querySelector('.memory-panel')).toBeNull();
    expect(transcriptBtn.getAttribute('aria-pressed')).toBe('true');
    expect(memoryBtn.getAttribute('aria-pressed')).toBe('false');

    // Pressing the button of the view already showing closes the drawer.
    fireEvent.click(transcriptBtn);
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(true);
    expect(transcriptBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('Plans is a third view of the drawer, pressed only while it shows, and says plans need memory when memory is off (P4-T07)', () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const { container } = render(<ChatPage createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    const plansBtn = screen.getByRole('button', { name: 'Plans' });
    const memoryBtn = screen.getByRole('button', { name: 'Memory' });
    expect(plansBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(plansBtn);
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('.plans-panel')).toBeTruthy();
    expect(screen.getByText(/Plans are kept with memory/)).toBeTruthy();
    expect(plansBtn.getAttribute('aria-pressed')).toBe('true');
    expect(memoryBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(memoryBtn);
    expect(container.querySelector('.plans-panel')).toBeNull();
    expect(container.querySelector('.memory-panel')).toBeTruthy();
    expect(plansBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(plansBtn);
    fireEvent.click(plansBtn);
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(true);
    expect(plansBtn.getAttribute('aria-pressed')).toBe('false');
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
/** `plays` true: every sentence plays to its end at once, so a spoken answer settles (P6-T05). */
function fakeSpeaker(plays = false) {
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
        if (plays) for (const listener of listeners) listener({ type: 'ended', id, at: 0 });
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

  it('leaves on a camera the person was still turning on when face reading began (CI, 2026-09-29)', async () => {
    const r = faceRig({ agreed: true });
    let answer: (() => void) | null = null;
    const camera = { getTracks: () => [r.track] } as unknown as MediaStream;
    r.getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (answer = () => resolve(camera))));
    fireEvent.click(screen.getByRole('button', { name: 'Camera' }));
    await waitFor(() => expect(r.getUserMedia).toHaveBeenCalledTimes(1));
    fireEvent.click(r.button()); // the camera has not answered yet
    await act(async () => {
      answer?.();
      await settle();
    });
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

function wikiServer(): FakeMcpServer {
  return new FakeMcpServer('DeepWiki', [
    {
      info: { name: 'read_wiki_structure', description: 'The topics of a repository.', inputSchema: { type: 'object', properties: { repoName: { type: 'string' } } }, annotations: null },
      run: () => textResult('1. Overview'),
    },
  ]);
}

/** The model asks for the tool once, then answers with whatever the tool gave it. */
function toolCaller(): (options: ChatLlmOptions) => LLMProvider {
  return () => {
    let asked = false;
    return {
      id: 'fake',
      async listModels(): Promise<LlmModel[]> {
        return [];
      },
      async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
        if (request.reasoning === 'off') {
          yield { type: 'text-delta', text: '{"facts":[],"ended":[]}' };
          yield { type: 'finish', reason: 'stop', usage: null };
          return;
        }
        if (!asked && request.tools.some((tool) => tool.name === 'deepwiki__read_wiki_structure')) {
          asked = true;
          yield { type: 'tool-call', call: { id: 'c1', name: 'deepwiki__read_wiki_structure', arguments: { repoName: 'vitest-dev/vitest' }, source: 'llm', requestedAt: '2026-09-30T00:00:00.000Z' } };
          yield { type: 'finish', reason: 'tool-calls', usage: null };
          return;
        }
        const gotIt = request.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('Overview'));
        yield { type: 'text-delta', text: gotIt ? 'The wiki has an Overview.' : 'I will carry on without it.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    };
  };
}

describe('ChatPage — MCP tools (P5-T01, ADR-42)', () => {
  const ORIGINAL_INNER_WIDTH = window.innerWidth;

  afterEach(() => {
    setViewportWidth(ORIGINAL_INNER_WIDTH);
  });

  async function askForTool(server: FakeMcpServer, connectTools?: NonNullable<ChatPageProps['connectTools']>): Promise<void> {
    setViewportWidth(1600);
    const storage = memoryStorage();
    seedConfigured(storage);
    render(
      <ChatPage
        buildProvider={toolCaller()}
        connectTools={
          connectTools ??
          (async () => ({
            connected: [{ id: 'srv-1', label: 'DeepWiki', client: server, tools: await server.listTools() }],
            statuses: [{ id: 'srv-1', label: 'DeepWiki', ok: true, detail: '1 tool' }],
          }))
        }
        createRenderer={fakeCreateRenderer}
        deps={testDeps({ storage })}
      />,
    );
    await act(() => settle());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'what is in the vitest wiki?' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  }

  it('asks first; Allow once runs the tool, and the transcript says so and shows her answer', async () => {
    const server = wikiServer();
    await askForTool(server);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(`${CHAT_CHARACTER_NAME} wants to use DeepWiki · read_wiki_structure`);
    expect(dialog.textContent).toContain('vitest-dev/vitest');
    expect(server.calls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await screen.findByText(`${CHAT_CHARACTER_NAME} used deepwiki · read_wiki_structure`);
    await screen.findByText('The wiki has an Overview.');
    expect(server.calls).toEqual([{ name: 'read_wiki_structure', args: { repoName: 'vitest-dev/vitest' } }]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Deny leaves the server uncalled and the transcript says she did not use it', async () => {
    const server = wikiServer();
    await askForTool(server);

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await screen.findByText(new RegExp(`${CHAT_CHARACTER_NAME} did not use deepwiki · read_wiki_structure`));
    await screen.findByText('I will carry on without it.');
    expect(server.calls).toEqual([]);
  });

  it('a server that could not be connected puts a notice in the transcript', async () => {
    await askForTool(wikiServer(), async () => ({
      connected: [],
      statuses: [{ id: 'srv-1', label: 'DeepWiki', ok: false, detail: 'Failed to fetch' }],
    }));
    await screen.findByText(/DeepWiki could not be reached \(Failed to fetch\), so its tools are off this visit\./);
  });
});

/** She searches once, then answers from the passage and cites it, the tag split across tokens. */
function searcher(): (options: ChatLlmOptions) => LLMProvider {
  return () => {
    let searched = false;
    return {
      id: 'fake',
      async listModels(): Promise<LlmModel[]> {
        return [];
      },
      async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
        if (request.reasoning === 'off') {
          yield { type: 'text-delta', text: '{"facts":[],"ended":[]}' };
          yield { type: 'finish', reason: 'stop', usage: null };
          return;
        }
        if (!searched && request.tools.some((tool) => tool.name === 'documents_search')) {
          searched = true;
          yield { type: 'tool-call', call: { id: 'c1', name: 'documents_search', arguments: { query: 'boiler reset' }, source: 'llm', requestedAt: '2026-10-09T00:00:00.000Z' } };
          yield { type: 'finish', reason: 'tool-calls', usage: null };
          return;
        }
        for (const text of ['Hold the green button for eleven seconds.', ' [ci', 'te:c6612]', ' Then wait two minutes. [cite:c999]']) yield { type: 'text-delta', text };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    };
  };
}

describe('ChatPage — cited answers (P5-T04, ADR-45)', () => {
  const ORIGINAL_INNER_WIDTH = window.innerWidth;

  afterEach(() => {
    setViewportWidth(ORIGINAL_INNER_WIDTH);
  });

  it('offers her search when it is on, shows that she looked, and lists the source she cited — and one she was not given', async () => {
    setViewportWidth(1600);
    const storage = memoryStorage();
    seedConfigured(storage);
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}'), documents: { search: true } }));
    const hit = { chunkId: '6612', documentId: '24', collection: 'C:/manuals', title: 'Boiler manual', text: 'Hold the green reset button for eleven seconds.', score: 1, source: 'C:/manuals/boiler.pdf', locator: 'p. 7' };
    const ingest = {
      status: async () => ({ folders: [{ path: 'C:/manuals', exists: true, documents: 1, chunks: 9 }], embedding: null, watching: true, job: null, configError: null }),
      scan: async () => {
        throw new Error('not used');
      },
      job: async () => {
        throw new Error('not used');
      },
      search: async () => ({ hits: [hit], vectorSearch: 'no-model' as const }),
    };
    const stage = new DisplayRenderer();
    render(
      <ChatPage
        buildProvider={searcher()}
        connectDocs={(options) => connectDocuments({ ...options, ingest })}
        createRenderer={() => stage}
        deps={testDeps({ storage })}
      />,
    );
    await act(() => settle());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'how do I reset the boiler?' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await screen.findByText(`${CHAT_CHARACTER_NAME} looked in your documents`);
    await screen.findByText(/Hold the green button for eleven seconds\. Then wait two minutes\./u);
    expect(document.body.textContent).not.toContain('[cite');
    await screen.findByText('1. Boiler manual, p. 7');
    expect(screen.getByText('2. A source she was not given')).toBeTruthy();

    // The screen in the room shows the source she was given, not the one she made up (P5-T08).
    await waitFor(() => expect(stage.shown.at(-1)?.screen?.items.map((item) => item.title)).toEqual(['Boiler manual']));
    expect(stage.shown.at(-1)?.screen?.items[0]).toMatchObject({ where: 'p. 7', text: 'Hold the green reset button for eleven seconds.' });
  });
});

/** P6-T05: her answers think aloud to the model; her thoughts are asked for with `INNER_MARKER`. */
function thinker(): { build: (options: ChatLlmOptions) => LLMProvider; inner: LlmRequest[] } {
  const inner: LlmRequest[] = [];
  const build = (): LLMProvider => ({
    id: 'thinker',
    async listModels(): Promise<LlmModel[]> {
      return [];
    },
    async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
      if (systemOf(request).includes(INNER_MARKER)) {
        inner.push(request);
        yield { type: 'text-delta', text: 'They sound worn out, PRIVATE-LINE.\nI want to ask about it later.' };
      } else {
        yield { type: 'reasoning-delta', text: 'SECRET-PLAN: the user is tired. ' };
        yield { type: 'text-delta', text: '<think>HIDDEN-THOUGHT</think>Long day? ' };
        yield { type: 'text-delta', text: 'Sit down a minute.' };
      }
      yield { type: 'finish', reason: 'stop', usage: null };
    },
  });
  return { build, inner };
}

describe('ChatPage — her thoughts (P6-T05, ADR-54)', () => {
  it('Thoughts shows her private lines behind a spoken answer; the voice and the transcript never have them', async () => {
    setViewportWidth(1024);
    const storage = memoryStorage();
    seedConfigured(storage);
    const deps = testDeps({ storage });
    deps.consent.grant([kokoroModel('fp32')]);
    const speaker = fakeSpeaker(true);
    const model = thinker();
    const { container } = render(<ChatPage buildProvider={model.build} createRenderer={fakeCreateRenderer} deps={deps} loadSpeaker={speaker.loadSpeaker} />);
    fireEvent.click(speakButton());
    await waitFor(() => expect(speakButton().getAttribute('aria-pressed')).toBe('true'));

    const thoughts = screen.getByRole('button', { name: 'Thoughts' });
    fireEvent.click(thoughts);
    expect(thoughts.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.inner-panel')).toBeTruthy();
    expect(screen.getByText(/Nothing yet/u)).toBeTruthy();

    await type('long day');
    await waitFor(() => expect(screen.getByText('They sound worn out, PRIVATE-LINE.')).toBeTruthy());
    expect(screen.getByText('I want to ask about it later.')).toBeTruthy();
    // What the model reasoned is there to peek at too, folded away.
    expect(container.querySelector('.inner-reasoning-text')?.textContent).toBe('SECRET-PLAN: the user is tired. HIDDEN-THOUGHT');
    await waitFor(() => expect(speaker.tts.requests.map((request) => request.text)).toEqual(['Long day?', 'Sit down a minute.']));

    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    const drawer = container.querySelector('.call-drawer');
    expect(drawer?.textContent).toContain('Sit down a minute.');
    for (const secret of ['SECRET-PLAN', 'HIDDEN-THOUGHT', 'PRIVATE-LINE']) {
      expect(drawer?.textContent, secret).not.toContain(secret);
      expect(speaker.tts.requests.some((request) => request.text.includes(secret)), secret).toBe(false);
    }

    // Closed, nothing more is asked of the model for her thoughts.
    expect(model.inner).toHaveLength(1);
    await type('yes');
    expect(model.inner).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Thoughts' }));
    await waitFor(() => expect(model.inner).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Thoughts' }));
    expect(container.querySelector('.call-drawer')?.hasAttribute('hidden')).toBe(true);
  });
});

/** Merges `extra` into the settings document `seedConfigured` wrote. */
function seedSettings(storage: Storage, extra: Record<string, unknown>): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}'), ...extra }));
}

function savedCharacter(storage: Storage): unknown {
  return (JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as { character?: unknown }).character;
}

/** `type`, for a page with the Memory view open: it has a search box of its own. */
async function sayInRoom(text: string): Promise<void> {
  const textbox = screen.getByPlaceholderText('Say something…');
  fireEvent.change(textbox, { target: { value: text } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  await act(() => settle());
}

function talkingTo(): HTMLSelectElement {
  return screen.getByLabelText('Talking to') as HTMLSelectElement;
}

/** Everything a drawer shows a person: its text and the values in its fields (facts are inputs). */
function drawerShows(container: HTMLElement): string {
  const drawer = container.querySelector('.call-drawer');
  const values = [...(drawer?.querySelectorAll('input, textarea') ?? [])].map((field) => (field as HTMLInputElement).value);
  return [drawer?.textContent ?? '', ...values].join('\n');
}

/**
 * A model that answers chat with a line, and reads facts out of what was said (the memory
 * extractor's system prompt is `EXTRACTION_SYSTEM`): "Mira" is a sister, "cello" is played.
 */
function rememberingModel(): { build: (options: ChatLlmOptions) => LLMProvider; chats: LlmRequest[] } {
  const chats: LlmRequest[] = [];
  const build = (): LLMProvider => ({
    id: 'remembering',
    async listModels(): Promise<LlmModel[]> {
      return [];
    },
    async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
      if (systemOf(request) === EXTRACTION_SYSTEM) {
        const said = request.messages.find((message) => message.role === 'user')?.content ?? '';
        const facts = [
          ...(said.includes('Mira') ? [{ subject: 'sister', predicate: 'name', object: 'Mira', confidence: 0.9, validFrom: null, replaces: null }] : []),
          ...(said.includes('cello') ? [{ subject: 'user', predicate: 'plays', object: 'cello', confidence: 0.9, validFrom: null, replaces: null }] : []),
        ];
        yield { type: 'text-delta', text: JSON.stringify({ facts, ended: [] }) };
      } else {
        chats.push(request);
        yield { type: 'text-delta', text: 'I see.' };
      }
      yield { type: 'finish', reason: 'stop', usage: null };
    },
  });
  return { build, chats };
}

/** A promise that waits until `release()` is called. */
function openGate(): { promise: Promise<void>; release: () => void } {
  let open: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, release: () => open?.() };
}

/** A speaker loader that records the voice and speed the page asked for, and otherwise is `fakeSpeaker`'s. */
function recordingSpeaker(): { loadSpeaker: () => Promise<SpeakerLoader>; started: { voiceId: string; speed: number }[] } {
  const speaker = fakeSpeaker();
  const started: { voiceId: string; speed: number }[] = [];
  const loadSpeaker = async (): Promise<SpeakerLoader> => {
    const loader = await speaker.loadSpeaker();
    return {
      voiceModelsFor: (settings) => loader.voiceModelsFor(settings),
      start: (options) => {
        started.push({ voiceId: options.settings.tts.voiceId, speed: options.settings.tts.speed });
        return loader.start(options);
      },
    };
  };
  return { loadSpeaker, started };
}

describe('ChatPage — characters (P6-T06, ADR-55)', () => {
  it("keeps two characters' memories apart in one store: Alice's is hers, Theo's is his, and each comes back as it was", async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    const store = new FakeMemoryStore();
    const model = rememberingModel();
    let chosen = 0;
    const chooseMemory = async () => {
      chosen += 1;
      return { store, kind: 'browser' as const, reason: 'a test store' };
    };
    const { container } = render(<ChatPage buildProvider={model.build} chooseMemory={chooseMemory} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    const hasFact = async (characterId: string, object: string): Promise<boolean> => (await store.currentFacts(characterId)).some((fact) => fact.object === object);
    /** A new visit has chosen its store and read it: say nothing before that. */
    const arrived = async (visits: number): Promise<void> => {
      await waitFor(() => expect(chosen).toBe(visits));
      await waitFor(() => expect(store.calls.filter((call) => call === 'currentFacts').length).toBeGreaterThanOrEqual(visits));
      await act(() => settle());
    };
    const switchTo = async (id: string): Promise<void> => {
      await waitFor(() => expect(talkingTo().disabled).toBe(false));
      fireEvent.change(talkingTo(), { target: { value: id } });
    };
    await arrived(1);

    // 1. As Alice, they tell her about their sister.
    expect(talkingTo().value).toBe('alice');
    await sayInRoom('my sister is called Mira');
    await waitFor(async () => expect(await hasFact('alice', 'Mira')).toBe(true));
    expect(systemOf(model.chats[0])).toContain('You are Alice.');

    // 2. Theo has none of it: not in his prompt, not in his store, not in his Memory view.
    await switchTo('theo');
    expect(savedCharacter(storage)).toBe('theo');
    await arrived(2);
    expect(talkingTo().value).toBe('theo');
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    await waitFor(() => expect(drawerShows(container)).toContain('Kept in a test store'));
    await act(() => settle());
    expect(drawerShows(container)).not.toContain('Mira');
    expect(await store.currentFacts('theo')).toEqual([]);
    await sayInRoom('hello');
    await waitFor(() => expect(model.chats).toHaveLength(2));
    expect(systemOf(model.chats[1])).toContain('You are Theo.');
    expect(systemOf(model.chats[1])).not.toContain('Mira');
    expect(systemOf(model.chats[1])).not.toContain('You are Alice.');

    // 3. What Theo is told is his.
    await sayInRoom('I play the cello');
    await waitFor(async () => expect(await hasFact('theo', 'cello')).toBe(true));

    // 4. Back to Alice: hers, and not his.
    await switchTo('alice');
    expect(savedCharacter(storage)).toBe('alice');
    await arrived(3);
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    await waitFor(() => expect(drawerShows(container)).toContain('Mira'));
    expect(drawerShows(container)).not.toContain('cello');
    await sayInRoom('hello again');
    await waitFor(() => expect(model.chats).toHaveLength(4));
    expect(systemOf(model.chats[3])).toContain('You are Alice.');
    expect(systemOf(model.chats[3])).toContain('Mira');
    expect(systemOf(model.chats[3])).not.toContain('cello');
    expect(await hasFact('alice', 'cello')).toBe(false);
    expect(await hasFact('theo', 'Mira')).toBe(false);
    expect((await store.currentFacts('alice')).map((fact) => fact.characterId)).toEqual(['alice']);
    expect((await store.currentFacts('theo')).map((fact) => fact.characterId)).toEqual(['theo']);
    // What Theo was told went down under his name.
    expect(new Set(store.rows.episodes.filter(({ episode }) => episode.text === 'I play the cello').map(({ episode }) => episode.characterId))).toEqual(new Set(['theo']));
  });

  it('opens as the character saved in Settings, and as Alice when that is one it does not have', async () => {
    for (const [saved, name] of [
      ['theo', 'Theo'],
      ['nobody', 'Alice'],
    ] as const) {
      const storage = memoryStorage();
      seedConfigured(storage);
      seedSettings(storage, { character: saved });
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
      const view = render(<ChatPage buildProvider={provider} chooseMemory={async () => null} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
      expect([...talkingTo().options].map((option) => option.textContent)).toEqual(['Alice', 'Theo']);
      expect(talkingTo().value).toBe(name.toLowerCase());
      await sayInRoom('hello');
      await waitFor(() => expect(seen).toHaveLength(1));
      expect(systemOf(seen[0])).toContain(`You are ${name}.`);
      view.unmount();
    }
  });

  it('cannot be switched while an answer is streaming, and can once it has finished', async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    const gate = openGate();
    const script: LlmStreamChunk[] = [
      { type: 'text-delta', text: 'One moment. ' },
      { type: 'text-delta', text: 'There.' },
      { type: 'finish', reason: 'stop', usage: null },
    ];
    render(<ChatPage buildProvider={scriptedProvider(script, { promise: gate.promise, after: 1 })} chooseMemory={async () => null} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    expect(talkingTo().disabled).toBe(false);
    await sayInRoom('hi');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy());
    expect(talkingTo().disabled).toBe(true);

    gate.release();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    await waitFor(() => expect(talkingTo().disabled).toBe(false));
  });

  it('cannot be switched while a voice call is open', async () => {
    const storage = memoryStorage();
    seedConfigured(storage);
    render(<ChatPage buildProvider={scriptedProvider([])} chooseMemory={async () => null} createRenderer={fakeCreateRenderer} deps={testDeps({ storage })} />);
    expect(talkingTo().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    await act(() => settle());
    expect(talkingTo().disabled).toBe(true);
  });

  it("speaks in the character's own voice: the one saved for Theo on Kokoro, else his persona's", async () => {
    for (const [saved, voiceId, speed] of [
      [{ theo: { voice: { kind: 'kokoro-browser', voiceId: 'bm_george', speed: 0.9 } } }, 'bm_george', 0.9],
      [{ theo: { voice: null } }, 'am_michael', 1],
      [{ alice: { voice: { kind: 'kokoro-browser', voiceId: 'bf_emma', speed: 1.1 } } }, 'am_michael', 1],
    ] as const) {
      const storage = memoryStorage();
      seedConfigured(storage);
      seedSettings(storage, { character: 'theo', characters: saved });
      const deps = testDeps({ storage });
      deps.consent.grant([kokoroModel('fp32')]);
      const speaker = recordingSpeaker();
      const view = render(<ChatPage buildProvider={scriptedProvider([])} chooseMemory={async () => null} createRenderer={fakeCreateRenderer} deps={deps} loadSpeaker={speaker.loadSpeaker} />);
      fireEvent.click(speakButton());
      await waitFor(() => expect(speakButton().getAttribute('aria-pressed')).toBe('true'));
      expect(speaker.started).toEqual([{ voiceId, speed }]);
      view.unmount();
    }
  });

  it("speaks as Alice with her persona's voice when nothing is saved, and with her saved one when something is", async () => {
    for (const [saved, voiceId] of [
      [{}, 'af_heart'],
      [{ alice: { voice: { kind: 'kokoro-browser', voiceId: 'bf_emma', speed: 1.1 } } }, 'bf_emma'],
    ] as const) {
      const storage = memoryStorage();
      seedConfigured(storage);
      seedSettings(storage, { characters: saved });
      const deps = testDeps({ storage });
      deps.consent.grant([kokoroModel('fp32')]);
      const speaker = recordingSpeaker();
      const view = render(<ChatPage buildProvider={scriptedProvider([])} chooseMemory={async () => null} createRenderer={fakeCreateRenderer} deps={deps} loadSpeaker={speaker.loadSpeaker} />);
      fireEvent.click(speakButton());
      await waitFor(() => expect(speakButton().getAttribute('aria-pressed')).toBe('true'));
      expect(speaker.started.map((call) => call.voiceId)).toEqual([voiceId]);
      view.unmount();
    }
  });
});

describe('ChatPage — her body, worn live (P7-T02, ADR-59)', () => {
  it('swaps between the placeholder, the generated Alice and their own .vrm mid-conversation, with the room, the transcript and memory untouched', async () => {
    // jsdom has no Blob URL registry; the stage makes one per body.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test-body'), revokeObjectURL: vi.fn() });
    try {
      const storage = memoryStorage();
      seedConfigured(storage);
      const store = new FakeMemoryStore();
      const model = rememberingModel();
      let chosen = 0;
      const chooseMemory = async () => {
        chosen += 1;
        return { store, kind: 'browser' as const, reason: 'a test store' };
      };
      const consent = new ModelConsent(memoryStorage());
      consent.grant([AVATAR_DESCRIPTOR]);
      const stage = new FakeAvatarRenderer();
      const createRenderer = vi.fn(() => stage);
      const fetchModel = vi.fn(async (_url: string, _descriptor: unknown) => new Uint8Array([1]));
      const shelf = new InMemoryBodyShelf();
      const checkBodyFile = vi.fn(async (bytes: Uint8Array): Promise<BodyReport> => {
        if (bytes[0] === 0) throw new Error('This model is missing bones every VRM body needs: leftHand.');
        return { name: 'My avatar', authors: ['Me'], licence: null, missing: ['blink'], lookAt: true };
      });
      const { container } = render(
        <ChatPage
          bodyShelf={shelf}
          buildProvider={model.build}
          checkBodyFile={checkBodyFile}
          chooseMemory={chooseMemory}
          createRenderer={createRenderer}
          deps={testDeps({ storage, consent })}
          fetchModel={fetchModel}
        />,
      );
      await waitFor(() => expect(chosen).toBe(1));
      await waitFor(() => expect(stage.character?.id).toBe('placeholder'));
      await act(() => settle());

      // 1. They talk; she remembers.
      await sayInRoom('my sister is called Mira');
      await waitFor(async () => expect((await store.currentFacts('alice')).some((fact) => fact.object === 'Mira')).toBe(true));

      // 2. The generated Alice: a built-in body, so it asks first, the placeholder still on stage.
      fireEvent.click(screen.getByRole('button', { name: 'Body' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Wear Alice, generated' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Wear this body' }));
      await waitFor(() => expect(stage.character?.id).toBe('alice-generated'));
      expect(fetchModel).toHaveBeenLastCalledWith(ALICE_GENERATED.downloadUrl, ALICE_GENERATED_DESCRIPTOR);

      // 3. Their own file: checked, kept, worn — nothing fetched for it.
      const add = screen.getByLabelText('Add a VRM body from this computer');
      fireEvent.change(add, { target: { files: [new File([new Uint8Array([1, 2])], 'mine.vrm')] } });
      await waitFor(() => expect(stage.character?.id.startsWith('own:')).toBe(true));
      expect(fetchModel).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('My avatar')).toBeTruthy();
      expect(screen.getByText('Cannot show blinking.')).toBeTruthy();

      // 4. A file the call cannot drive is refused with the reason, and kept nowhere.
      fireEvent.change(add, { target: { files: [new File([new Uint8Array([0])], 'statue.glb')] } });
      expect((await screen.findByRole('alert')).textContent).toBe('statue.glb: This model is missing bones every VRM body needs: leftHand.');
      expect(await shelf.list()).toHaveLength(1);
      expect(stage.character?.id.startsWith('own:')).toBe(true);

      // 5. Back to the placeholder.
      fireEvent.click(screen.getByRole('button', { name: 'Wear The placeholder (pixiv sample)' }));
      await waitFor(() => expect(stage.character?.id).toBe('placeholder'));
      const saved = JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as { characters?: Record<string, { body?: unknown }> };
      expect(saved.characters?.['alice']?.body).toBe('placeholder');

      // Untouched: one renderer, one visit, the same transcript and session, her memory in her prompt.
      expect(createRenderer).toHaveBeenCalledTimes(1);
      expect(chosen).toBe(1);
      await sayInRoom('hello again');
      await waitFor(() => expect(model.chats).toHaveLength(2));
      expect(model.chats[1]?.messages.some((message) => message.role === 'user' && message.content.includes('my sister is called Mira'))).toBe(true);
      expect(systemOf(model.chats[1])).toContain('Mira');
      expect(new Set(store.rows.episodes.map(({ episode }) => episode.sessionId)).size).toBe(1);
      fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
      await waitFor(() => expect(drawerShows(container)).toContain('my sister is called Mira'));
    } finally {
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
});
