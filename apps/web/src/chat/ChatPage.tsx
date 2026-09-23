import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { ChatSession, ConversationMachine, attachHistory, renderSystemPrompt } from '@latentpresence/core';
import type { ConversationEvent, LLMProvider } from '@latentpresence/protocol';
import { TranscriptPanel } from '../transcript/TranscriptPanel';
import { useTranscript } from '../transcript/useTranscript';
import { defaultSettingsDeps, type SettingsDeps } from '../settings/deps';
import { loadSettings, type Settings } from '../settings/settings';
import { defaultPersona } from '../persona/default-persona';
import type { CallStageRenderer } from '../call/CallStage';
import { useUserCamera, type UseUserCameraDeps } from '../call/useUserCamera';
import type { ActiveCall } from '../voice/VoicePanel';
import { chatLlmProvider, type ChatLlmOptions } from './chat-llm';
import { hostTimers } from './host-timers';

/** The character's name comes from the persona file now (P1-T12), not a constant. */
export const CHAT_CHARACTER_NAME = defaultPersona.name;
const SESSION_ID = 'chat';

/** Below this viewport width the transcript drawer starts closed (decision 9, P2-T06);
 * at or above it, open. A 1024 px column has no room for a 26vw drawer beside the stage. */
const DRAWER_OPEN_AT_PX = 1440;

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

/**
 * The stage (P2-T06, decision 2), `lazy()` the same way and for the same reason: it
 * imports three.js, `@pixiv/three-vrm` and `three/examples/jsm`, and a person who never
 * shows the character should not fetch any of them. `vite.config.ts`'s build guard drops
 * both names from its forbidden list at this task precisely because this import makes them
 * expected in a production chunk for the first time — the dev pages that used to be the
 * only route to them are guarded by different needles now.
 */
const CallStage = lazy(async () => {
  const module = await import('../call/CallStage');
  return { default: module.CallStage };
});

export interface ChatPageProps {
  readonly deps?: Partial<SettingsDeps>;
  /** Test-only seam: replaces the provider `chatLlmProvider` would otherwise build from
   * `deps`, so streaming, Stop and Enter/Shift+Enter can be exercised with a scripted
   * provider and no network. Production never passes this — the default is
   * `chatLlmProvider` itself, built exactly as `/settings` builds one. */
  readonly buildProvider?: (options: ChatLlmOptions) => LLMProvider;
  /** Test seam, forwarded to `CallStage`: a fake renderer factory in place of
   * `new VrmAvatarRenderer()`. Production never passes it. */
  readonly createRenderer?: (() => CallStageRenderer) | undefined;
  /** Test seam, forwarded to `useUserCamera`: an injectable `getUserMedia`. Production
   * never passes it. */
  readonly camera?: UseUserCameraDeps | undefined;
}

/**
 * `/chat` (P1-T11): the video-call layout (P2-T06). The stage fills the viewport, a
 * controls bar sits along the bottom, the transcript is a drawer on the right and the
 * user's own camera is a picture-in-picture in the bottom-left corner when turned on.
 * Typed and spoken turns are still one conversation on one machine and one history
 * (P1-T12b) — this task only moves where things sit, never how `ChatSession`,
 * `attachHistory` or `VoicePanel`'s state machine work.
 */
export function ChatPage({ deps: depsOverride, buildProvider = chatLlmProvider, createRenderer, camera }: ChatPageProps = {}): ReactElement {
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
      camera={camera}
      companionUrl={companionUrl}
      createRenderer={createRenderer}
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
  readonly createRenderer?: (() => CallStageRenderer) | undefined;
  readonly camera?: UseUserCameraDeps | undefined;
}

function ConfiguredChatPage({
  deps,
  endpoint,
  baseUrl,
  modelId,
  temperature,
  companionUrl,
  settings,
  buildProvider,
  createRenderer,
  camera: cameraDeps,
}: ConfiguredChatPageProps): ReactElement {
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
  // The running call itself, not just whether one is active — `CallStage` needs
  // `call.output` for lip sync and the Mute button needs `call.setMuted` (decision 5, 6).
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [textOpen, setTextOpen] = useState(true);
  // Read once: only the *starting* width decides the drawer's default (decision 9). A
  // window resized mid-session keeps whatever the person set with the Transcript button.
  const [drawerOpen, setDrawerOpen] = useState(() => window.innerWidth >= DRAWER_OPEN_AT_PX);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const userCamera = useUserCamera(cameraDeps);

  useEffect(() => machine.subscribe(() => setBusy(chat.busy)), [machine, chat]);

  // The PiP `<video>` takes a `MediaStream` through `srcObject`, which has no JSX prop —
  // it has to be set imperatively once the element exists and again whenever the stream
  // changes (a fresh `getUserMedia` call is a new `MediaStream`, not the same one updated).
  useEffect(() => {
    const video = pipVideoRef.current;
    if (video !== null) video.srcObject = userCamera.stream;
  }, [userCamera.stream]);

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

  const onCallStarted = useCallback((started: ActiveCall | null) => {
    setCall(started);
    // A fresh call always starts unmuted; ending one leaves nothing for the button to
    // toggle, so its own display state should not carry over to the next call either.
    setMuted(false);
  }, []);

  const onVoiceEnd = useCallback(() => {
    setVoiceOpen(false);
    setCallActive(false);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous;
      call?.setMuted?.(next);
      return next;
    });
  }, [call]);

  const toggleCamera = useCallback(() => {
    if (userCamera.active) userCamera.stop();
    else void userCamera.start();
  }, [userCamera]);

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

  // Docked above the bar and disabled during a call exactly as it was before the call
  // layout existed — now hidden outright rather than a greyed-out box nobody can use.
  const showTextBox = textOpen && !callActive;
  return (
    <main className="call-page">
      <Suspense fallback={<div className="call-stage call-stage-loading" />}>
        <CallStage call={call} consent={deps.consent} createRenderer={createRenderer} machine={machine} />
      </Suspense>

      <aside className={`call-drawer ${drawerOpen ? '' : 'call-drawer-closed'}`} hidden={!drawerOpen}>
        <TranscriptPanel characterName={CHAT_CHARACTER_NAME} lines={lines} onClear={clear} />
      </aside>

      {userCamera.active && (
        <div className="call-pip">
          {/* Nothing reads a pixel from this element — no canvas, no `captureStream`, no
              recorder. It is a live view of the stream for the person on this end, mirrored
              like a mirror rather than like a camera, and nothing else. */}
          <video autoPlay className="call-pip-video" muted playsInline ref={pipVideoRef} />
        </div>
      )}
      {!userCamera.active && userCamera.error !== null && (
        <div className="call-pip call-pip-error">
          <p>Camera: {userCamera.error}</p>
        </div>
      )}

      {voiceOpen && (
        <div className="call-voice-card">
          <Suspense fallback={<p className="boot-status">Loading the voice panel…</p>}>
            <VoicePanel
              deps={deps}
              history={history}
              llm={llm}
              machine={machine}
              modelId={modelId}
              onActive={onVoiceActive}
              onCallStarted={onCallStarted}
              onEnd={onVoiceEnd}
              settings={settings}
              temperature={temperature}
            />
          </Suspense>
        </div>
      )}

      {showTextBox && (
        <div className="call-text-dock">
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
      )}

      <div className="call-controls-bar">
        {!voiceOpen && (
          <button className="btn btn-primary" onClick={() => setVoiceOpen(true)} type="button">
            Start voice
          </button>
        )}
        <button aria-pressed={muted} className="btn call-control-btn" disabled={!callActive} onClick={toggleMute} type="button">
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button aria-pressed={userCamera.active} className="btn call-control-btn" onClick={toggleCamera} type="button">
          Camera
        </button>
        <button aria-pressed={showTextBox} className="btn call-control-btn" onClick={() => setTextOpen((open) => !open)} type="button">
          Text
        </button>
        <button aria-pressed={drawerOpen} className="btn call-control-btn" onClick={() => setDrawerOpen((open) => !open)} type="button">
          Transcript
        </button>
        <a className="btn btn-ghost call-control-btn" href="/settings">
          Settings
        </a>
      </div>
    </main>
  );
}
