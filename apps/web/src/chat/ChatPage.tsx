import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import {
  ChatSession,
  ConversationMachine,
  DEFAULT_AFFECT_PARAMS,
  MemoryKernel,
  Plans,
  SelfNotes,
  attachAffect,
  attachHistory,
  attachMemory,
  attachMood,
  planTools,
  selfNoteTools,
  withLocalTools,
  attachUserAffect,
  renderSystemPrompt,
  type AttachedAffect,
  type AttachedMemory,
  type AttachedMood,
  type LocalTool,
  type ChatVoice,
} from '@latentpresence/core';
import { ListeningReactor } from '@latentpresence/avatar';
import type { ConversationEvent, LLMProvider, ModelDescriptor } from '@latentpresence/protocol';
import type { AudioOutputHandle } from '@latentpresence/providers';
import { ConsentScreen } from '../consent/ConsentScreen';
import { TranscriptPanel } from '../transcript/TranscriptPanel';
import { useTranscript } from '../transcript/useTranscript';
import { MemoryPanel } from '../memory/MemoryPanel';
import { PlansPanel } from '../plan/PlansPanel';
import { defaultSettingsDeps, type SettingsDeps } from '../settings/deps';
import { loadSettings, type Settings } from '../settings/settings';
import { defaultPersona } from '../persona/default-persona';
import type { CallStageAffect, CallStageRenderer } from '../call/CallStage';
import { useUserCamera, type UseUserCameraDeps } from '../call/useUserCamera';
import { AffectOverlay } from '../call/AffectOverlay';
import type { ActiveCall } from '../voice/VoicePanel';
import type { FaceReadingHandle, FaceReadingOptions, FaceReadingStatus } from '../call/face-reading';
import { chatLlmProvider, type ChatLlmOptions } from './chat-llm';
import { chooseMemoryStore, type ChooseMemoryOptions, type MemoryChoice } from './chat-memory';
import { hostTimers } from './host-timers';

/** The character's name comes from the persona file now (P1-T12), not a constant. */
export const CHAT_CHARACTER_NAME = defaultPersona.name;
/**
 * One session per visit (P4-T04b): memory recall leaves out the asking session, because the
 * history already carries it — so a fixed id would hide every earlier visit from her.
 */
function newSessionId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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

/** What `/chat` needs from the speaker that reads typed replies aloud (P2-T08). `Speaker`
 * satisfies it; a test hands over one with no audio graph behind it. */
export interface SpeakerLike {
  readonly voice: ChatVoice;
  readonly output: AudioOutputHandle | null;
  stop(): Promise<void>;
}

/** The speaker module, loaded on the first click of Speak replies and never before. */
export interface SpeakerLoader {
  voiceModelsFor(settings: Settings): ModelDescriptor[];
  start(options: { settings: Settings; deps: SettingsDeps; consent: SettingsDeps['consent'] }): Promise<SpeakerLike>;
}

/**
 * `lazy()`'s reasoning without a component: `voice/speaker.ts` imports kokoro-js and ONNX
 * Runtime, so it is fetched when a person asks her to speak, not with the page.
 */
async function loadDefaultSpeaker(): Promise<SpeakerLoader> {
  const module = await import('../voice/speaker');
  return { voiceModelsFor: module.voiceModelsFor, start: (options) => module.Speaker.start(options) };
}

type SpeakPhase = 'off' | 'consent' | 'starting' | 'on';

/** The face-reading module (P3-T06), loaded on the first click of *Read my face*. */
export interface FaceReadingLoader {
  faceReadingModels(): ModelDescriptor[];
  startFaceReading(options: FaceReadingOptions): Promise<FaceReadingHandle>;
}

/** `lazy()`'s reasoning again: `call/face-reading.ts` imports MediaPipe's worker. */
async function loadDefaultFaceReading(): Promise<FaceReadingLoader> {
  const module = await import('../call/face-reading');
  return { faceReadingModels: module.faceReadingModels, startFaceReading: module.startFaceReading };
}

type FacePhase = 'off' | 'consent' | 'starting' | 'on';

/** What the light on the user's picture says while face reading runs. */
function faceIndicatorText(face: FacePhase, status: FaceReadingStatus | null): string {
  if (face === 'starting' || status === null) return 'Starting face reading…';
  return status.reading === null ? 'Reading your face · no face seen' : `Reading your face · ${status.reading.label}`;
}

/** The body's view of the page's affect engine (P3-T09): what `affectToBody` reads, now, and her baseline. */
function stageAffectOf(affect: AttachedAffect): CallStageAffect {
  const { baseline } = DEFAULT_AFFECT_PARAMS;
  return {
    inputs: () => {
      const state = affect.state();
      return { mood: state.mood, energy: state.energy, stance: state.stance, feeling: affect.feeling() };
    },
    baseline: { mood: baseline.mood, energy: baseline.energy, stance: baseline.stance, feeling: { label: 'neutral', intensity: 0 } },
  };
}

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
  /** Test seam: the speaker module (P2-T08). Production never passes it. */
  readonly loadSpeaker?: () => Promise<SpeakerLoader>;
  /** Test seam: the face-reading module (P3-T06). Production never passes it. */
  readonly loadFaceReading?: () => Promise<FaceReadingLoader>;
  /** Test seam: where memory lives (P4-T04b). Production never passes it. */
  readonly chooseMemory?: (options: ChooseMemoryOptions) => Promise<MemoryChoice | null>;
}

/**
 * `/chat` (P1-T11): the video-call layout (P2-T06). The stage fills the viewport, a
 * controls bar sits along the bottom, the transcript is a drawer on the right and the
 * user's own camera is a picture-in-picture in the bottom-left corner when turned on.
 * Typed and spoken turns are still one conversation on one machine and one history
 * (P1-T12b) — this task only moves where things sit, never how `ChatSession`,
 * `attachHistory` or `VoicePanel`'s state machine work.
 */
export function ChatPage({
  deps: depsOverride,
  buildProvider = chatLlmProvider,
  createRenderer,
  camera,
  loadSpeaker = loadDefaultSpeaker,
  loadFaceReading = loadDefaultFaceReading,
  chooseMemory = chooseMemoryStore,
}: ChatPageProps = {}): ReactElement {
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
      chooseMemory={chooseMemory}
      loadFaceReading={loadFaceReading}
      loadSpeaker={loadSpeaker}
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
  readonly loadSpeaker: () => Promise<SpeakerLoader>;
  readonly loadFaceReading: () => Promise<FaceReadingLoader>;
  readonly chooseMemory: (options: ChooseMemoryOptions) => Promise<MemoryChoice | null>;
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
  loadSpeaker,
  loadFaceReading,
  chooseMemory,
}: ConfiguredChatPageProps): ReactElement {
  // One machine, one history and one session for the life of the page. A lazy `useState`
  // initializer rather than a ref: building either has a side effect (the machine starts)
  // that must happen exactly once, and a ref's value used later is what oxlint's
  // `react(refs)` rule exists to catch — state is the React-blessed way to hold something
  // built once.
  const [{ sessionId, machine, chat, history, llm, rawLlm, affect, userAffect, stageAffect, listening, memoryHolder, selfHolder }] = useState(() => {
    const builtSessionId = newSessionId();
    // P4-T04b: filled in once the store is chosen (the effect below); read by every request.
    const builtMemoryHolder: { current: AttachedMemory | null } = { current: null };
    // P4-T06 (ADR-40): her own notes and the tools she keeps them with, from the same store.
    // P4-T07 (ADR-41): her plans with them, kept with tools in the same store.
    const builtSelfHolder: { notes: SelfNotes | null; plans: Plans | null; tools: LocalTool[] } = { notes: null, plans: null, tools: [] };
    const builtMachine = new ConversationMachine({
      sessionId: builtSessionId,
      characterId: defaultPersona.id,
      // P1-T15. Without this the machine sticks on `interrupted` after a barge-in or a
      // typed Stop — see `host-timers.ts`, which is a comment about exactly this trap.
      scheduler: hostTimers(),
    });
    // P3-T09: one affect engine for the page, fed by the same bus — `[emote:x]` tags now,
    // the user's affect from P3-T07. It starts at her baseline and takes the saved mood, aged by
    // the time away, once the store answers (P4-T06, the effect below).
    const builtAffect = attachAffect(builtMachine, { characterId: defaultPersona.id });
    // P3-T07: how the user seems, fused from their words, voice and face, on the same bus —
    // what it publishes the engine above takes in by empathy, and the prompt says in a line.
    const builtUserAffect = attachUserAffect(builtMachine, { sessionId: builtSessionId });
    // `now` is fixed when the page mounts: it is what the model is told the time is, and a
    // clock rewritten per turn would change the prompt under a provider's prompt cache for
    // the sake of a clock nobody is watching that closely. **The mood is not fixed** — it is
    // read on every request, and it is the prompt's last two lines, so a cached prefix
    // survives it (P3-T03).
    // **The history is attached here, not by `ChatSession`** (P1-T12b): a voice call on
    // this page is handed the same one, and a history that watched the bus twice would
    // count every message twice. Whoever creates it owns its subscription.
    const mountedAt = new Date();
    const attached = attachHistory(builtMachine, {
      system: () =>
        renderSystemPrompt(defaultPersona, {
          now: mountedAt,
          userName: null,
          affect: builtAffect.state(),
          userAffect: builtUserAffect.fusion.last(),
          // P4-T04b (ADR-38): ready before the request, never awaited by it.
          memory: builtMemoryHolder.current?.context() ?? null,
          notes: builtSelfHolder.notes?.notes() ?? [],
          plans: builtSelfHolder.plans?.promptContext() ?? null,
        }),
    }).history;
    const builtProvider = buildProvider({ endpointId: endpoint, baseUrl, companionUrl, deps });
    // P4-T06 (ADR-40): every answer — typed, spoken or in a call — may keep a note; the tools
    // are read per request, so they arrive when the store does. Extraction keeps the bare one.
    const builtChatLlm = withLocalTools(builtProvider, () => builtSelfHolder.tools);
    const builtChat = new ChatSession({
      sessionId: builtSessionId,
      machine: builtMachine,
      llm: builtChatLlm,
      modelId,
      temperature,
      history: attached,
    });
    builtMachine.start();
    return {
      sessionId: builtSessionId,
      memoryHolder: builtMemoryHolder,
      selfHolder: builtSelfHolder,
      machine: builtMachine,
      chat: builtChat,
      history: attached,
      llm: builtChatLlm,
      rawLlm: builtProvider,
      affect: builtAffect,
      userAffect: builtUserAffect,
      stageAffect: stageAffectOf(builtAffect),
      // P3-T08: how she listens — the call tells it where the user pauses and how loud they
      // are, the stage reads it every frame against the user's live fused estimate.
      listening: { reactor: new ListeningReactor(), userAffect: () => builtUserAffect.fusion.current(Date.now()) },
    };
  });

  // Memory (P4-T04b, ADR-38): the store is chosen once per visit from Settings → Memory — this
  // browser by default — and a kernel fed by the bus fills the prompt's memory note.
  // Extraction runs on the page's own model with reasoning off (ADR-37), off the speaking path.
  // `memoryHolder` (a plain ref, read during system-prompt render) and this state (read by the
  // memory browser, P4-T05) are kept in step — one attach, two readers with different needs.
  const [memory, setMemory] = useState<AttachedMemory | null>(null);
  const [memoryWhere, setMemoryWhere] = useState<string | null>(null);
  // The plans (P4-T07) for the panel: state, because the panel renders from it; `selfHolder`
  // holds the same object for the prompt, which reads it outside React.
  const [plans, setPlans] = useState<Plans | null>(null);
  useEffect(() => {
    let live = true;
    let attached: AttachedMemory | null = null;
    let mood: AttachedMood | null = null;
    const saveMood = (): void => void mood?.save();
    void chooseMemory({
      setting: settings.memory,
      companionUrl,
      fetch: deps.fetch,
      indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
    }).then((choice) => {
      if (!live || choice === null) return;
      const warn = (error: Error, stage: string): void => console.warn(`memory (${stage}, ${choice.kind}): ${error.message}`);
      const kernel = new MemoryKernel({ store: choice.store, characterId: defaultPersona.id, extractor: { llm: rawLlm, modelId }, onError: warn });
      attached = attachMemory(machine, { kernel, sessionId, userAffect: () => userAffect.fusion.last(), onError: (error) => warn(error, 'recall') });
      memoryHolder.current = attached;
      setMemory(attached);
      setMemoryWhere(choice.reason);
      // P4-T06 (ADR-40): her notes, and her mood as she left it, aged by the time away — saved
      // after every answer, and once more as the page goes (a best effort; a closing tab may
      // not wait for it).
      const notes = new SelfNotes({ store: choice.store, characterId: defaultPersona.id });
      void notes.load().catch((error: unknown) => warn(error instanceof Error ? error : new Error(String(error)), 'notes'));
      selfHolder.notes = notes;
      // P4-T07 (ADR-41): plans in the same store; follow-ups are facts, so they go through the kernel.
      const builtPlans = new Plans({ store: choice.store, characterId: defaultPersona.id, followUps: kernel });
      void builtPlans.load().catch((error: unknown) => warn(error instanceof Error ? error : new Error(String(error)), 'plans'));
      selfHolder.plans = builtPlans;
      setPlans(builtPlans);
      selfHolder.tools = [...selfNoteTools(notes), ...planTools(builtPlans)];
      mood = attachMood(machine, { affect, notes, onError: (error) => warn(error, 'mood') });
      window.addEventListener('pagehide', saveMood);
    });
    return () => {
      live = false;
      attached?.detach();
      memoryHolder.current = null;
      setMemory(null);
      setMemoryWhere(null);
      window.removeEventListener('pagehide', saveMood);
      if (mood !== null) {
        void mood.save();
        mood.detach();
      }
      selfHolder.notes = null;
      selfHolder.plans = null;
      setPlans(null);
      selfHolder.tools = [];
    };
  }, [affect, chooseMemory, companionUrl, deps.fetch, machine, memoryHolder, modelId, rawLlm, selfHolder, sessionId, settings.memory, userAffect]);

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
  // Which view the drawer shows (P4-T05, P4-T07). Always transcript at first, per the
  // rule above — Memory and Plans only open the drawer when a person asks it to.
  const [drawerView, setDrawerView] = useState<'transcript' | 'memory' | 'plans'>('transcript');
  /** The Transcript, Memory and Plans buttons share this: pressing the view already showing
   * closes the drawer, pressing the other switches to it (opening the drawer if closed). */
  const toggleDrawerView = useCallback(
    (view: 'transcript' | 'memory' | 'plans') => {
      if (drawerOpen && drawerView === view) {
        setDrawerOpen(false);
        return;
      }
      setDrawerView(view);
      setDrawerOpen(true);
    },
    [drawerOpen, drawerView],
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const userCamera = useUserCamera(cameraDeps);

  // Typed replies spoken aloud (P2-T08). `speaker` is state for the stage's lip sync;
  // `speakerRef` is the same object for teardown, which must not wait on a render.
  const [speak, setSpeak] = useState<SpeakPhase>('off');
  const [speaker, setSpeaker] = useState<SpeakerLike | null>(null);
  const [speakStatus, setSpeakStatus] = useState<string | null>(null);
  const [speakConsent, setSpeakConsent] = useState<{ loader: SpeakerLoader; models: ModelDescriptor[] } | null>(null);
  const speakerRef = useRef<SpeakerLike | null>(null);
  // False once the page has gone, so a speaker that finishes loading afterwards is closed
  // rather than left holding a worker and an audio graph nobody can reach.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      chat.setVoice(null);
      void speakerRef.current?.stop();
      speakerRef.current = null;
    };
  }, [chat]);

  useEffect(() => machine.subscribe(() => setBusy(chat.busy)), [machine, chat]);

  // Reading the user's face (P3-T06). Opt-in, off on every visit: nothing here touches the
  // camera or fetches the model until the person has clicked *Read my face* and — the first
  // time — agreed on the card that says what it does. The reading goes nowhere yet; P3-T07
  // fuses it with text and voice.
  const [face, setFace] = useState<FacePhase>('off');
  const [faceConsent, setFaceConsent] = useState<{ loader: FaceReadingLoader; models: ModelDescriptor[] } | null>(null);
  const [faceLoader, setFaceLoader] = useState<FaceReadingLoader | null>(null);
  const [faceStatus, setFaceStatus] = useState<FaceReadingStatus | null>(null);
  const [faceError, setFaceError] = useState<string | null>(null);
  const faceHandleRef = useRef<FaceReadingHandle | null>(null);
  // True when face reading is what turned the camera on, so turning it off turns the camera
  // off too; a camera the person had on already stays on.
  const faceOwnsCameraRef = useRef(false);
  // The run being started or running, if any (see the effect below).
  const faceRunRef = useRef<object | null>(null);

  const stopFace = useCallback(() => {
    faceRunRef.current = null;
    faceHandleRef.current?.stop();
    faceHandleRef.current = null;
    if (faceOwnsCameraRef.current) userCamera.stop();
    faceOwnsCameraRef.current = false;
    setFaceLoader(null);
    setFaceStatus(null);
    setFace('off');
  }, [userCamera]);

  useEffect(
    () => () => {
      // A run still loading when the page goes finds itself stale and stops itself.
      faceRunRef.current = null;
      faceHandleRef.current?.stop();
    },
    [],
  );

  /** Agreed: the camera comes on (if it was off), and the effect below starts reading once its video exists. */
  const beginFace = useCallback(
    (loader: FaceReadingLoader) => {
      setFaceConsent(null);
      setFaceError(null);
      setFaceLoader(loader);
      setFace('starting');
      if (userCamera.active) return;
      // A camera the person is already turning on is theirs, not face reading's to turn off.
      faceOwnsCameraRef.current = !userCamera.starting;
      // A refused camera ends it here; its reason is already on screen where the PiP would be.
      void userCamera.start().then((started) => {
        if (started) return;
        faceOwnsCameraRef.current = false;
        stopFace();
      });
    },
    [stopFace, userCamera],
  );

  const toggleFace = useCallback(async () => {
    if (face === 'on' || face === 'starting') {
      stopFace();
      return;
    }
    if (face !== 'off') return;
    setFaceError(null);
    const loader = await loadFaceReading();
    const models = loader.faceReadingModels();
    if (deps.consent.has(models)) {
      beginFace(loader);
    } else {
      setFaceConsent({ loader, models });
      setFace('consent');
    }
  }, [beginFace, deps.consent, face, loadFaceReading, stopFace]);

  // Starts reading once there is a camera picture to read. (A refused camera and a camera
  // turned off are handled where they happen, in `beginFace` and `toggleCamera`.)
  // **A run is a token, not an effect's lifetime.** This effect re-runs when `face` itself
  // flips to `on`, so a cleanup that cancelled the run would drop every reading the run
  // ever made — which is exactly what the first version did. Stopping clears the token;
  // a run that finds itself no longer current stops itself.
  useEffect(() => {
    const video = pipVideoRef.current;
    if (face !== 'starting' || faceLoader === null || userCamera.stream === null || video === null || faceRunRef.current !== null) return;
    const run = {};
    faceRunRef.current = run;
    const current = (): boolean => faceRunRef.current === run;
    faceLoader
      .startFaceReading({
        consent: deps.consent,
        video,
        onStatus: (status) => {
          if (!current()) return;
          setFaceStatus(status);
          // P3-T07: the face is one witness among the fusion's four.
          if (status.reading !== null) userAffect.face(status.reading, Date.now());
        },
        onError: (message) => {
          if (!current()) return;
          stopFace();
          setFaceError(message);
        },
      })
      .then((handle) => {
        if (!current()) {
          handle.stop();
          return;
        }
        faceHandleRef.current = handle;
        setFace('on');
      })
      .catch((error: unknown) => {
        if (!current()) return;
        stopFace();
        setFaceError(error instanceof Error ? error.message : String(error));
      });
  }, [deps.consent, face, faceLoader, stopFace, userAffect, userCamera.stream]);

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

  const startSpeaking = useCallback(
    async (loader: SpeakerLoader) => {
      setSpeakConsent(null);
      setSpeak('starting');
      setSpeakStatus('Loading the voice…');
      try {
        const started = await loader.start({ settings, deps, consent: deps.consent });
        if (!aliveRef.current) {
          void started.stop();
          return;
        }
        speakerRef.current = started;
        // Her mood in her voice (P3-T09): the same engine the stage and the prompt read.
        chat.setVoice({ ...started.voice, voiceStyle: affect.voiceStyle });
        setSpeaker(started);
        setSpeak('on');
        setSpeakStatus(null);
      } catch (error) {
        setSpeak('off');
        setSpeakStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [affect, chat, deps, settings],
  );

  /** Back to text. `setVoice(null)` first: it stops an answer that is still speaking. */
  const stopSpeaking = useCallback(() => {
    const current = speakerRef.current;
    speakerRef.current = null;
    chat.setVoice(null);
    void current?.stop();
    setSpeaker(null);
    setSpeak('off');
  }, [chat]);

  /**
   * The switch. Its consent is the voice's alone — `voiceModelsFor`, not a call's list: with
   * no microphone there is no Silero, no Smart Turn and no recogniser to ask about, and a
   * server voice asks about nothing. Agreed once, here or by Start voice, it never asks again.
   */
  const toggleSpeak = useCallback(async () => {
    if (speak === 'on') {
      stopSpeaking();
      return;
    }
    if (speak !== 'off') return;
    setSpeakStatus(null);
    const loader = await loadSpeaker();
    const models = loader.voiceModelsFor(settings);
    if (deps.consent.has(models)) {
      await startSpeaking(loader);
    } else {
      setSpeakConsent({ loader, models });
      setSpeak('consent');
    }
  }, [deps.consent, loadSpeaker, settings, speak, startSpeaking, stopSpeaking]);

  /** A call brings its own voice, and two would load Kokoro twice: speaking typed replies
   * ends when a call begins. */
  const openVoice = useCallback(() => {
    stopSpeaking();
    setVoiceOpen(true);
  }, [stopSpeaking]);

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
    if (userCamera.active) {
      // No camera, nothing to read: face reading goes with it.
      faceOwnsCameraRef.current = false;
      stopFace();
      userCamera.stop();
    } else {
      void userCamera.start();
    }
  }, [stopFace, userCamera]);

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

  // Docked above the bar, and gone for as long as the voice panel is open — not only while
  // a call is live. The panel's card sits in the same place, and with both showing the text
  // box covered the consent card entirely (R-14, 2026-09-23): Start voice looked like it did
  // nothing. Typing is blocked for the call anyway.
  // The speaker's consent card takes the same place, for the same reason.
  const showTextBox = textOpen && !voiceOpen && speakConsent === null && faceConsent === null;
  // Lip sync follows whichever voice exists; a test call with no audio graph has none.
  const voiceOutput = call?.output ?? speaker?.output ?? null;
  // The two centred cards shift left of an open drawer rather than sliding under it (R-14).
  // `/chat?affect`: the fused state, for a person checking what she thinks they feel (P3-T07).
  const showAffectOverlay = new URLSearchParams(window.location.search).has('affect');
  const pageClass = drawerOpen ? 'call-page call-page-drawer-open' : 'call-page';
  return (
    <main className={pageClass}>
      <Suspense fallback={<div className="call-stage call-stage-loading" />}>
        <CallStage
          affect={stageAffect}
          consent={deps.consent}
          createRenderer={createRenderer}
          listening={listening}
          machine={machine}
          voice={voiceOutput}
        />
      </Suspense>

      {showAffectOverlay && <AffectOverlay affect={affect} listening={listening.reactor} userAffect={userAffect} />}

      <aside className={`call-drawer ${drawerOpen ? '' : 'call-drawer-closed'}`} hidden={!drawerOpen}>
        {drawerView === 'memory' ? (
          <MemoryPanel characterName={CHAT_CHARACTER_NAME} memory={memory} subscribe={subscribe} where={memoryWhere} />
        ) : drawerView === 'plans' ? (
          <PlansPanel characterName={CHAT_CHARACTER_NAME} plans={plans} />
        ) : (
          <TranscriptPanel characterName={CHAT_CHARACTER_NAME} lines={lines} onClear={clear} />
        )}
      </aside>

      {userCamera.active && (
        <div className="call-pip">
          {/* Nothing reads a pixel from this element — no canvas, no `captureStream`, no
              recorder. It is a live view of the stream for the person on this end, mirrored
              like a mirror rather than like a camera, and nothing else. */}
          <video autoPlay className="call-pip-video" muted playsInline ref={pipVideoRef} />
          {/* The light (P3-T06): on for exactly as long as frames are being read. */}
          {(face === 'on' || face === 'starting') && (
            <div className="call-pip-indicator" data-testid="face-indicator" role="status">
              <span className="call-pip-light" />
              {faceIndicatorText(face, faceStatus)}
            </div>
          )}
        </div>
      )}
      {faceError !== null && face === 'off' && <p className="call-face-error">Face reading: {faceError}</p>}
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
              listening={listening.reactor}
              llm={llm}
              machine={machine}
              modelId={modelId}
              onActive={onVoiceActive}
              onCallStarted={onCallStarted}
              onEnd={onVoiceEnd}
              settings={settings}
              temperature={temperature}
              userAffect={userAffect}
              voiceStyle={affect.voiceStyle}
            />
          </Suspense>
        </div>
      )}

      {speakConsent !== null && (
        <div className="call-voice-card">
          <ConsentScreen
            descriptors={speakConsent.models}
            onAgree={() => {
              deps.consent.grant(speakConsent.models);
              void startSpeaking(speakConsent.loader);
            }}
            onCancel={() => {
              setSpeakConsent(null);
              setSpeak('off');
            }}
          />
        </div>
      )}

      {faceConsent !== null && (
        <div className="call-voice-card">
          <ConsentScreen
            agreeLabel="Turn on face reading"
            cancelLabel="Not now"
            descriptors={faceConsent.models}
            heading="Read your expression from the camera?"
            intro={`${CHAT_CHARACTER_NAME} can watch your expression through your camera to tell how you seem. A model running in this browser reads each frame and drops it at once: no frame is saved or sent anywhere, and only a mood estimate is kept. It is off until you turn it on, and a light on your picture shows while it runs. Agreeing turns on the camera and downloads this model:`}
            onAgree={() => {
              deps.consent.grant(faceConsent.models);
              beginFace(faceConsent.loader);
            }}
            onCancel={() => {
              setFaceConsent(null);
              setFace('off');
            }}
          />
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
          {speakStatus !== null && <p className="chat-speak-status">{speakStatus}</p>}
        </div>
      )}

      <div className="call-controls-bar">
        {!voiceOpen && (
          <button className="btn btn-primary" disabled={speak === 'consent' || speak === 'starting'} onClick={openVoice} type="button">
            Start voice
          </button>
        )}
        <button aria-pressed={muted} className="btn call-control-btn" disabled={!callActive} onClick={toggleMute} type="button">
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button aria-pressed={userCamera.active} className="btn call-control-btn" onClick={toggleCamera} type="button">
          Camera
        </button>
        <button
          aria-pressed={face === 'on' || face === 'starting'}
          className="btn call-control-btn"
          disabled={face === 'consent'}
          onClick={() => void toggleFace()}
          title="Let her read your expression from the camera (opt-in, stays on this computer)"
          type="button"
        >
          Read my face
        </button>
        <button aria-pressed={showTextBox} className="btn call-control-btn" disabled={voiceOpen} onClick={() => setTextOpen((open) => !open)} type="button">
          Text
        </button>
        <button
          aria-pressed={speak === 'on'}
          className="btn call-control-btn"
          disabled={voiceOpen || speak === 'consent' || speak === 'starting'}
          onClick={() => void toggleSpeak()}
          title="Speak typed replies aloud"
          type="button"
        >
          {speak === 'starting' ? 'Loading voice…' : 'Speak replies'}
        </button>
        <button aria-pressed={drawerOpen && drawerView === 'transcript'} className="btn call-control-btn" onClick={() => toggleDrawerView('transcript')} type="button">
          Transcript
        </button>
        <button aria-pressed={drawerOpen && drawerView === 'memory'} className="btn call-control-btn" onClick={() => toggleDrawerView('memory')} type="button">
          Memory
        </button>
        <button aria-pressed={drawerOpen && drawerView === 'plans'} className="btn call-control-btn" onClick={() => toggleDrawerView('plans')} type="button">
          Plans
        </button>
        <a className="btn btn-ghost call-control-btn" href="/settings">
          Settings
        </a>
      </div>
    </main>
  );
}
