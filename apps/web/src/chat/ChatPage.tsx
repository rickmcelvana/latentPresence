import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { ChatSession, ConversationMachine, renderSystemPrompt } from '@latentpresence/core';
import type { ConversationEvent, LLMProvider } from '@latentpresence/protocol';
import { TranscriptPanel } from '../transcript/TranscriptPanel';
import { useTranscript } from '../transcript/useTranscript';
import { defaultSettingsDeps, type SettingsDeps } from '../settings/deps';
import { loadSettings, type Settings } from '../settings/settings';
import { defaultPersona } from '../persona/default-persona';
import { chatLlmProvider, type ChatLlmOptions } from './chat-llm';

/** The character's name comes from the persona file now (P1-T12), not a constant. */
export const CHAT_CHARACTER_NAME = defaultPersona.name;
const SESSION_ID = 'chat';

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
 * language model configured in `/settings`. No voice yet — a browser voice needs
 * download consent (P1-T13).
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
  readonly buildProvider: (options: ChatLlmOptions) => LLMProvider;
}

function ConfiguredChatPage({ deps, endpoint, baseUrl, modelId, temperature, companionUrl, buildProvider }: ConfiguredChatPageProps): ReactElement {
  // One machine and one session for the life of the page. A lazy `useState` initializer
  // rather than a ref: building either has a side effect (the machine starts) that must
  // happen exactly once, and a ref's value used later is what oxlint's `react(refs)` rule
  // exists to catch — state is the React-blessed way to hold something built once.
  const [{ machine, chat }] = useState(() => {
    const builtMachine = new ConversationMachine({ sessionId: SESSION_ID, characterId: defaultPersona.id });
    const builtChat = new ChatSession({
      sessionId: SESSION_ID,
      machine: builtMachine,
      llm: buildProvider({ endpointId: endpoint, baseUrl, companionUrl, deps }),
      modelId,
      temperature,
      // Rendered once, when the page mounts: `now` is what the model is told the time is,
      // and re-rendering it per turn would rewrite the prompt under a provider's prompt
      // cache for the sake of a clock nobody is watching that closely.
      system: renderSystemPrompt(defaultPersona, { now: new Date(), userName: null }),
    });
    builtMachine.start();
    return { machine: builtMachine, chat: builtChat };
  });

  // `stop`, not `dispose`: StrictMode runs this cleanup once on mount in development, and a
  // disposed session refuses every later message — the page would never answer.
  useEffect(() => () => chat.stop(), [chat]);

  const subscribe = useMemo(() => (listener: (event: ConversationEvent) => void) => machine.subscribe(listener), [machine]);
  const { lines, clear } = useTranscript(subscribe);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(chat.busy);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => machine.subscribe(() => setBusy(chat.busy)), [machine, chat]);

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
      <div className="chat-box">
        <textarea
          className="textarea chat-textarea"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Say something…"
          ref={inputRef}
          value={draft}
        />
        <div className="chat-actions">
          <button className="btn btn-primary" disabled={draft.trim() === ''} onClick={send} type="button">
            Send
          </button>
          {busy && (
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
