import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { ChatSession, ConversationMachine, attachHistory, renderSystemPrompt } from '@latentpresence/core';
import type { ConversationEvent, LLMProvider } from '@latentpresence/protocol';
import { TranscriptPanel } from '../transcript/TranscriptPanel';
import { useTranscript } from '../transcript/useTranscript';
import { defaultSettingsDeps, type SettingsDeps } from '../settings/deps';
import { loadSettings, type Settings } from '../settings/settings';
import { defaultPersona } from '../persona/default-persona';
import { chatLlmProvider, type ChatLlmOptions } from './chat-llm';
import { hostTimers } from './host-timers';

/** The character's name comes from the persona file now (P1-T12), not a constant. */
export const CHAT_CHARACTER_NAME = defaultPersona.name;
const SESSION_ID = 'chat';

/**
 * The voice panel (P1-T15), `lazy()` for a heavier reason than `/settings` gets: it imports
 * the browser models — transformers.js, ONNX Runtime and kokoro-js, plus their worker
 * chunks — and **none of that should be fetched by a person who only ever types**. Loading
 * it on the click, rather than with the page, is what keeps a typed conversation as light
 * as it was before voice existed. Nothing here is a build-exclusion guard: this panel is
 * meant to be in production, which is why `vite.config.ts` no longer forbids those names.
 */
const VoicePanel = lazy(async () => {
  const module = await import('../voice/VoicePanel');
  return { default: module.VoicePanel };
});

export interface ChatPageProps {
  readonly deps?: Partial<SettingsDeps>;
  /** Test-only seam: replaces the provider `chatLlmProvider` would otherwise build from
   * `deps`, so streaming, Stop and Enter/Shift+Enter can be exercised with a scripted
   * provider and no network. Production never passes this — the default is
   * `chatLlmProvider` itself, built exactly as `/settings` builds one. */
  readonly buildProvider?: (options: ChatLlmOptions) => LLMProvider;
}

/**
 * `/chat` (P1-T11): a production page, the transcript plus a text box, talking to the
 * language model configured in `/settings`. **Voice arrives here in P1-T15** — the same
 * machine, the same history and the same transcript, with the pipeline behind a button
 * rather than behind the dev-only harness.
 */
export function ChatPage({ deps: depsOverride, buildProvider = chatLlmProvider }: ChatPageProps = {}): ReactElement {
  const deps = useMemo<SettingsDeps>(() => ({ ...defaultSettingsDeps(), ...depsOverride }), [depsOverride]);
  const [settings] = useState<Settings>(() => loadSettings(deps.storage));
  const { llm, companionUrl } = settings;

  if (llm.endpoint === null || llm.modelId === null) {
    return (
      <main className="chat-page">
        <header className="chat-header">
          <h1>Chat</h1>
        </header>
        <p className="chat-unconfigured-note">
          Choose a language model and a model in Settings before you can chat here. <a href="/settings">Go to Settings</a>.
        </p>
      </main>
    );
  }

  return (
    <ConfiguredChatPage
      baseUrl={llm.baseUrl}
      buildProvider={buildProvider}
      companionUrl={companionUrl}
      deps={deps}
      endpoint={llm.endpoint}
      modelId={llm.modelId}
      settings={settings}
      temperature={llm.temperature}
    />
  );
}

interface ConfiguredChatPageProps {
  readonly deps: SettingsDeps;
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly temperature: number | null;
  readonly companionUrl: string;
  readonly settings: Settings;
  readonly buildProvider: (options: ChatLlmOptions) => LLMProvider;
}

function ConfiguredChatPage({ deps, endpoint, baseUrl, modelId, temperature, companionUrl, settings, buildProvider }: ConfiguredChatPageProps): ReactElement {
  // One machine, one history and one session for the life of the page. A lazy `useState`
  // initializer rather than a ref: building either has a side effect (the machine starts)
  // that must happen exactly once, and a ref's value used later is what oxlint's
  // `react(refs)` rule exists to catch — state is the React-blessed way to hold something
  // built once.
  const [{ machine, chat, history, llm }] = useState(() => {
    const builtMachine = new ConversationMachine({
      sessionId: SESSION_ID,
      characterId: defaultPersona.id,
      // P1-T15. Without this the machine sticks on `interrupted` after a barge-in or a
      // typed Stop — see `host-timers.ts`, which is a comment about exactly this trap.
      scheduler: hostTimers(),
    });
    // Rendered once, when the page mounts: `now` is what the model is told the time is,
    // and re-rendering it per turn would rewrite the prompt under a provider's prompt
    // cache for the sake of a clock nobody is watching that closely.
    // **The history is attached here, not by `ChatSession`** (P1-T12b): a voice call on
    // this page is handed the same one, and a history that watched the bus twice would
    // count every message twice. Whoever creates it owns its subscription.
    const attached = attachHistory(builtMachine, {
      system: renderSystemPrompt(defaultPersona, { now: new Date(), userName: null }),
    }).history;
    const builtProvider = buildProvider({ endpointId: endpoint, baseUrl, companionUrl, deps });
    const builtChat = new ChatSession({
      sessionId: SESSION_ID,
      machine: builtMachine,
      llm: builtProvider,
      modelId,
      temperature,
      history: attached,
    });
    builtMachine.start();
    return { machine: builtMachine, chat: builtChat, history: attached, llm: builtProvider };
  });

  // `stop`, not `dispose`: StrictMode runs this cleanup once on mount in development, and a
  // disposed session refuses every later message — the page would never answer.
  useEffect(() => () => chat.stop(), [chat]);

  const subscribe = useMemo(() => (listener: (event: ConversationEvent) => void) => machine.subscribe(listener), [machine]);
  const { lines, clear } = useTranscript(subscribe);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(chat.busy);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // A call owns the conversation while it runs: the microphone is open and a typed message
  // arriving mid-answer would be a second turn racing the one being spoken. The keyboard
  // goes away for the call's duration and comes back when it ends.
  const [callActive, setCallActive] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => machine.subscribe(() => setBusy(chat.busy)), [machine, chat]);

  /**
   * Stable identities, and that is not tidiness. An inline arrow here was the bug that
   * reached a person on 2026-09-22: a new function on every render, an effect that stopped
   * the call when its dependency changed, and a `/chat` that showed a live microphone while
   * hearing nothing. `VoicePanel` no longer allows that to matter — it keeps the callback in
   * a ref — and these are `useCallback` anyway so the next prop of this shape cannot either.
   */
  const onVoiceActive = useCallback(
    (active: boolean) => {
      setCallActive(active);
      // A typed answer still streaming when the call starts would leave the machine in
      // `speaking`, and `VoiceSession` deliberately ignores a turn that ends while the
      // character is audible — so the first thing said into the microphone would be
      // swallowed. Switching to voice ends the typed answer, which is what Stop does anyway:
      // the transcript keeps what was shown and strikes the rest.
      if (active) chat.stop();
    },
    [chat],
  );

  const onVoiceEnd = useCallback(() => {
    setVoiceOpen(false);
    setCallActive(false);
  }, []);

  function send(): void {
    if (draft.trim() === '') return;
    if (chat.send(draft)) {
      setDraft('');
      // Busy from the moment it is sent, not from the first token: a model still loading can
      // take seconds to say anything, and Stop has to be there for that wait.
      setBusy(chat.busy);
    }
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends; Shift+Enter is a new line.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <main className="chat-page">
      <header className="chat-header">
        <h1>Chat</h1>
      </header>
      <TranscriptPanel characterName={CHAT_CHARACTER_NAME} lines={lines} onClear={clear} />
      {voiceOpen ? (
        <Suspense fallback={<p className="boot-status">Loading the voice panel…</p>}>
          <VoicePanel
            deps={deps}
            history={history}
            llm={llm}
            machine={machine}
            modelId={modelId}
            onActive={onVoiceActive}
            onEnd={onVoiceEnd}
            settings={settings}
            temperature={temperature}
          />
        </Suspense>
      ) : (
        <div className="voice-controls">
          <button className="btn btn-ghost" onClick={() => setVoiceOpen(true)} type="button">
            Start voice
          </button>
          <span className="field-hint">Talk to the character instead of typing.</span>
        </div>
      )}
      <div className="chat-box">
        <textarea
          className="textarea chat-textarea"
          disabled={callActive}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={callActive ? 'On a call — end it to type.' : 'Say something…'}
          ref={inputRef}
          value={draft}
        />
        <div className="chat-actions">
          <button className="btn btn-primary" disabled={callActive || draft.trim() === ''} onClick={send} type="button">
            Send
          </button>
          {busy && !callActive && (
            <button className="btn btn-ghost" onClick={() => chat.stop()} type="button">
              Stop
            </button>
          )}
          <span className="chat-hint">Enter sends · Shift+Enter for a new line</span>
        </div>
      </div>
    </main>
  );
}
