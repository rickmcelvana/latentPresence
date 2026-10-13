import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import {
  ChatSession,
  ConversationMachine,
  DEFAULT_AFFECT_PARAMS,
  INITIATIVE_BLOCK,
  REST_BLOCK,
  MemoryKernel,
  Plans,
  PermissionPrompts,
  Schedules,
  SelfNotes,
  agentExecutor,
  attachAffect,
  attachDeliveries,
  attachScheduler,
  attachHistory,
  attachInitiative,
  attachInnerMonologue,
  attachMemory,
  attachRest,
  attachMood,
  mcpTools,
  planTools,
  scheduleTools,
  selfNoteTools,
  toolResultOf,
  citedSources,
  withLocalTools,
  withThinking,
  attachUserAffect,
  lastConversation,
  renderSystemPrompt,
  type AttachedAffect,
  type AttachedDeliveries,
  type AttachedInitiative,
  type AttachedRest,
  type AttachedMemory,
  type AttachedMood,
  type AttachedScheduler,
  type ConnectedToolServer,
  type LastConversation,
  type LocalTool,
  type ChatVoice,
} from '@latentpresence/core';
import { ListeningReactor, type Displays } from '@latentpresence/avatar';
import type { ConversationEvent, LLMProvider, ModelDescriptor } from '@latentpresence/protocol';
import type { AudioOutputHandle } from '@latentpresence/providers';
import { ConsentScreen } from '../consent/ConsentScreen';
import { TranscriptPanel, type CitationSource } from '../transcript/TranscriptPanel';
import { useTranscript } from '../transcript/useTranscript';
import { MemoryPanel } from '../memory/MemoryPanel';
import { PlansPanel } from '../plan/PlansPanel';
import { SchedulesPanel } from '../schedule/SchedulesPanel';
import { InnerPanel } from '../inner/InnerPanel';
import { defaultSettingsDeps, type SettingsDeps } from '../settings/deps';
import { loadSettings, saveSettings, type Settings } from '../settings/settings';
import { DEFAULT_CHARACTER_ID, PACKS, packFor, type CharacterPack } from '../characters/packs';
import { withCharacterVoice } from '../characters/voice';
import type { CallStageAffect, CallStageRenderer } from '../call/CallStage';
import { latestCitedSources, pickPlan, planToWhiteboard, sourcesToScreen } from '../call/displays';
import { useUserCamera, type UseUserCameraDeps } from '../call/useUserCamera';
import { AffectOverlay } from '../call/AffectOverlay';
import type { ActiveCall } from '../voice/VoicePanel';
import type { FaceReadingHandle, FaceReadingOptions, FaceReadingStatus } from '../call/face-reading';
import { chatLlmProvider, type ChatLlmOptions } from './chat-llm';
import { chooseMemoryStore, type ChooseMemoryOptions, type MemoryChoice } from './chat-memory';
import { connectToolServers, homePrompt, settingsToolGrants, type ConnectToolServersOptions, type ToolServerStatus } from './chat-tools';
import { connectDocuments, type ConnectDocumentsOptions, type ConnectedDocuments } from './chat-documents';
import { hostTimers } from './host-timers';
import { browserNotifications, type PageNotifications } from './notifications';
import { PermissionPrompt } from './PermissionPrompt';

/** The browser's notifications, built once: an effect depends on the object, so a default built per render would restart it. */
const browserPageNotifications = browserNotifications();

/** The person's own zone: the browser's, which is where "Thursday at 9" is read (ADR-58). */
function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Alice's name, the default character's (P1-T12); the page itself reads the active pack's persona (P6-T06). */
export const CHAT_CHARACTER_NAME = packFor(DEFAULT_CHARACTER_ID).persona.name;
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
  /** Test seam: connecting the MCP servers in Settings → Tools (P5-T01). Production never passes it. */
  readonly connectTools?: ConnectTools;
  /** Test seam: asking the companion for her documents (P5-T04). Production never passes it. */
  readonly connectDocs?: (options: ConnectDocumentsOptions) => Promise<ConnectedDocuments>;
  /** Test seam: the browser's OS notifications (P6-T08). Production never passes it. */
  readonly notifications?: PageNotifications;
}

type ConnectTools = (options: ConnectToolServersOptions) => Promise<{ readonly connected: ConnectedToolServer[]; readonly statuses: ToolServerStatus[] }>;

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
  connectTools = connectToolServers,
  connectDocs = connectDocuments,
  notifications = browserPageNotifications,
}: ChatPageProps = {}): ReactElement {
  const deps = useMemo<SettingsDeps>(() => ({ ...defaultSettingsDeps(), ...depsOverride }), [depsOverride]);
  const [settings] = useState<Settings>(() => loadSettings(deps.storage));
  // P6-T06 (ADR-55): who she is this visit. Read once; a switch saves it and remounts the room below.
  const [characterId, setCharacterId] = useState(() => settings.character);
  const pack = packFor(characterId);
  const switchCharacter = useCallback(
    (id: string) => {
      saveSettings({ ...loadSettings(deps.storage), character: id }, deps.storage);
      setCharacterId(id);
    },
    [deps.storage],
  );
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
      key={pack.persona.id}
      baseUrl={llm.baseUrl}
      buildProvider={buildProvider}
      camera={camera}
      companionUrl={companionUrl}
      createRenderer={createRenderer}
      deps={deps}
      endpoint={llm.endpoint}
      chooseMemory={chooseMemory}
      connectTools={connectTools}
      connectDocs={connectDocs}
      notifications={notifications}
      loadFaceReading={loadFaceReading}
      loadSpeaker={loadSpeaker}
      modelId={llm.modelId}
      onSwitch={switchCharacter}
      pack={pack}
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
  /** P6-T06 (ADR-55): who this room is for, and how to change that. The room is keyed by the pack's id,
   * so a switch mounts a new one: a new session, with everything below built for the new character. */
  readonly pack: CharacterPack;
  readonly onSwitch: (id: string) => void;
  readonly buildProvider: (options: ChatLlmOptions) => LLMProvider;
  readonly createRenderer?: (() => CallStageRenderer) | undefined;
  readonly camera?: UseUserCameraDeps | undefined;
  readonly loadSpeaker: () => Promise<SpeakerLoader>;
  readonly loadFaceReading: () => Promise<FaceReadingLoader>;
  readonly chooseMemory: (options: ChooseMemoryOptions) => Promise<MemoryChoice | null>;
  readonly connectTools: ConnectTools;
  readonly connectDocs: (options: ConnectDocumentsOptions) => Promise<ConnectedDocuments>;
  readonly notifications: PageNotifications;
}

function ConfiguredChatPage({
  deps,
  endpoint,
  baseUrl,
  modelId,
  temperature,
  companionUrl,
  settings,
  pack,
  onSwitch,
  buildProvider,
  createRenderer,
  camera: cameraDeps,
  loadSpeaker,
  loadFaceReading,
  chooseMemory,
  connectTools,
  connectDocs,
  notifications,
}: ConfiguredChatPageProps): ReactElement {
  // One machine, one history and one session for the life of the page. A lazy `useState`
  // initializer rather than a ref: building either has a side effect (the machine starts)
  // that must happen exactly once, and a ref's value used later is what oxlint's
  // `react(refs)` rule exists to catch — state is the React-blessed way to hold something
  // built once.
  const [{ sessionId, machine, chat, history, llm, rawLlm, affect, userAffect, stageAffect, listening, memoryHolder, selfHolder, chatTools, toolsHolder, docsHolder, timeHolder, inner, webSources, permissionPrompts }] = useState(() => {
    const builtSessionId = newSessionId();
    // P4-T04b: filled in once the store is chosen (the effect below); read by every request.
    const builtMemoryHolder: { current: AttachedMemory | null } = { current: null };
    // P4-T06 (ADR-40): her own notes and the tools she keeps them with, from the same store.
    // P4-T07 (ADR-41): her plans with them, kept with tools in the same store.
    // P6-T08 (ADR-58): her schedules and their tools, when the store keeps schedules.
    const builtSelfHolder: { notes: SelfNotes | null; plans: Plans | null; schedules: Schedules | null; tools: LocalTool[] } = { notes: null, plans: null, schedules: null, tools: [] };
    // P5-T01 (ADR-42): the MCP servers once connected (the effect below), their tools behind the
    // gate; the person's decisions live in the settings document, read at every call.
    const builtToolsHolder: { servers: ConnectedToolServer[] } = { servers: [] };
    // P5-T04 (ADR-45): her search of the person's documents, once the companion says it has
    // some (the effect below), and the hits she was given — what the transcript cites from.
    const builtDocsHolder: { connected: ConnectedDocuments | null } = { connected: null };
    // P6-T02 (ADR-51): when they last talked, read from the store once it is chosen.
    const builtTimeHolder: { since: LastConversation | null } = { since: null };
    // P5-T06 (ADR-47): what the web gave her to cite, beside her documents' hits.
    const builtWebSources = new Map<string, CitationSource>();
    const builtPrompts = new PermissionPrompts({ timers: hostTimers() });
    const grants = settingsToolGrants(deps.storage);
    const builtMachine = new ConversationMachine({
      sessionId: builtSessionId,
      characterId: pack.persona.id,
      // P1-T15. Without this the machine sticks on `interrupted` after a barge-in or a
      // typed Stop — see `host-timers.ts`, which is a comment about exactly this trap.
      scheduler: hostTimers(),
    });
    // P3-T09: one affect engine for the page, fed by the same bus — `[emote:x]` tags now,
    // the user's affect from P3-T07. It starts at her baseline and takes the saved mood, aged by
    // the time away, once the store answers (P4-T06, the effect below).
    const builtAffect = attachAffect(builtMachine, { characterId: pack.persona.id });
    // P3-T07: how the user seems, fused from their words, voice and face, on the same bus —
    // what it publishes the engine above takes in by empathy, and the prompt says in a line.
    const builtUserAffect = attachUserAffect(builtMachine, { sessionId: builtSessionId });
    // `now` is read on every request (it was fixed at mount until 2026-10-09): "check in with me
    // in a few hours" needs her to know the time, and a follow-up only comes due if the clock
    // moves (R-27). It is the first line of RIGHT NOW, the prompt's last section, after the
    // memory and plans that change per turn anyway — a cached prefix survives it, as it does
    // the mood (P3-T03).
    // **The history is attached here, not by `ChatSession`** (P1-T12b): a voice call on
    // this page is handed the same one, and a history that watched the bus twice would
    // count every message twice. Whoever creates it owns its subscription.
    const attached = attachHistory(builtMachine, {
      system: (turn) =>
        renderSystemPrompt(pack.persona, {
          now: new Date(),
          userName: null,
          affect: builtAffect.state(),
          userAffect: builtUserAffect.fusion.last(),
          // P4-T04b (ADR-38): ready before the request, never awaited by it.
          memory: builtMemoryHolder.current?.context() ?? null,
          notes: builtSelfHolder.notes?.notes() ?? [],
          plans: builtSelfHolder.plans?.promptContext() ?? null,
          toolServers: builtToolsHolder.servers.map((server) => server.label),
          // P5-T07 (ADR-48): the room is read per request, so a change in Settings applies at once.
          home: homePrompt(builtToolsHolder.servers, loadSettings(deps.storage).tools.homeArea),
          documents: builtDocsHolder.connected?.tool != null,
          since: builtTimeHolder.since,
          opening: turn.opening,
        }),
    }).history;
    const builtProvider = buildProvider({ endpointId: endpoint, baseUrl, companionUrl, deps });
    // P6-T05 (ADR-54): her inner monologue, for the page's life as the chat is. Her answers'
    // thinking — the model's reasoning, and any <think> a server leaves in the words — goes to it
    // and never into what is shown or spoken; her lines are asked of the bare provider (as
    // extraction and sleep are) only while the Thoughts view is showing.
    const builtInner = attachInnerMonologue(builtMachine, {
      llm: builtProvider,
      modelId,
      character: { name: pack.persona.name, summary: pack.persona.summary },
      onError: (error) => console.warn(`thoughts: ${error.message}`),
    });
    const thinkingProvider = withThinking(builtProvider, (text) => builtInner.hear(text));
    // P4-T06 (ADR-40): every answer — typed, spoken or in a call — may keep a note; the tools
    // are read per request, so they arrive when the store does. Extraction keeps the bare one.
    // P5-T01 (ADR-42): the MCP tools join hers, built per request so a policy set to never in
    // Settings drops the tool at once; every call that reaches outside goes on the bus, for
    // the transcript. Hers (no `server__` in the name) are not shown.
    // P5-T04: her document search is hers too, but shown — the person should see she looked.
    // Every call but her own notes and plans is shown — a name she guessed too (R-29), so a
    // call that ran nothing is never invisible.
    const outside = (name: string): boolean => !builtSelfHolder.tools.some((tool) => tool.definition.name === name);
    const docsTool = (): LocalTool[] => (builtDocsHolder.connected?.tool == null ? [] : [builtDocsHolder.connected.tool]);
    // The tools her chat has now: also what a scheduled task may name (P6-T08), through the same gate.
    const builtChatTools = (): LocalTool[] => [...builtSelfHolder.tools, ...docsTool(), ...mcpTools(builtToolsHolder.servers, { grants, prompts: builtPrompts })];
    const builtChatLlm = withLocalTools(thinkingProvider, builtChatTools, {
      onCallStart: (call) => {
        if (outside(call.name)) builtMachine.dispatch({ type: 'tool.call', sessionId: builtSessionId, at: new Date().toISOString(), call });
      },
      onCall: (call, result) => {
        if (!outside(call.name)) return;
        for (const found of citedSources(result)) builtWebSources.set(found.ref, found);
        const at = new Date().toISOString();
        builtMachine.dispatch({ type: 'tool.result', sessionId: builtSessionId, at, result: toolResultOf(call, result, at) });
      },
    });
    const builtChat = new ChatSession({
      sessionId: builtSessionId,
      machine: builtMachine,
      llm: builtChatLlm,
      // P6-T02 (ADR-51): her opener is asked with no tools — nothing has been asked of her yet.
      openingLlm: thinkingProvider,
      modelId,
      temperature,
      history: attached,
    });
    builtMachine.start();
    return {
      sessionId: builtSessionId,
      memoryHolder: builtMemoryHolder,
      selfHolder: builtSelfHolder,
      chatTools: builtChatTools,
      toolsHolder: builtToolsHolder,
      docsHolder: builtDocsHolder,
      timeHolder: builtTimeHolder,
      inner: builtInner,
      webSources: builtWebSources,
      permissionPrompts: builtPrompts,
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
  // P6-T08 (ADR-58): the schedules, the same way; null where the store keeps none.
  const [schedules, setSchedules] = useState<Schedules | null>(null);
  const timeZone = localTimeZone();
  // P6-T02, P6-T03 (ADR-51, ADR-52): she does not speak first into an open voice panel — the call
  // is theirs to start — nor while they are typing.
  const voiceOpenRef = useRef(false);
  const draftRef = useRef('');
  // P6-T04 (ADR-53): her rest, for the stage (read every frame) and the label (state).
  const [rest, setRest] = useState<AttachedRest | null>(null);
  const [restingNow, setRestingNow] = useState(false);
  useEffect(() => {
    let live = true;
    let attached: AttachedMemory | null = null;
    let mood: AttachedMood | null = null;
    let initiative: AttachedInitiative | null = null;
    let resting: AttachedRest | null = null;
    let scheduler: AttachedScheduler | null = null;
    let deliveries: AttachedDeliveries | null = null;
    let stopResting = (): void => {};
    const wakeHer = (): void => resting?.wake();
    const saveMood = (): void => void mood?.save();
    void chooseMemory({
      setting: settings.memory,
      companionUrl,
      fetch: deps.fetch,
      indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
    }).then((choice) => {
      if (!live || choice === null) return;
      const warn = (error: Error, stage: string): void => console.warn(`memory (${stage}, ${choice.kind}): ${error.message}`);
      const kernel = new MemoryKernel({ store: choice.store, characterId: pack.persona.id, extractor: { llm: rawLlm, modelId }, onError: warn });
      attached = attachMemory(machine, { kernel, sessionId, userAffect: () => userAffect.fusion.last(), onError: (error) => warn(error, 'recall') });
      memoryHolder.current = attached;
      setMemory(attached);
      setMemoryWhere(choice.reason);
      if (choice.warning !== undefined) machine.dispatch({ type: 'error', sessionId, at: new Date().toISOString(), scope: 'memory', message: choice.warning });
      // P4-T06 (ADR-40): her notes, and her mood as she left it, aged by the time away — saved
      // after every answer, and once more as the page goes (a best effort; a closing tab may
      // not wait for it).
      const notes = new SelfNotes({ store: choice.store, characterId: pack.persona.id });
      const notesLoaded = notes.load().catch((error: unknown) => warn(error instanceof Error ? error : new Error(String(error)), 'notes'));
      selfHolder.notes = notes;
      // P4-T07 (ADR-41): plans in the same store; follow-ups are facts, so they go through the kernel.
      const builtPlans = new Plans({ store: choice.store, characterId: pack.persona.id, followUps: kernel });
      const plansLoaded = builtPlans.load().catch((error: unknown) => warn(error instanceof Error ? error : new Error(String(error)), 'plans'));
      selfHolder.plans = builtPlans;
      setPlans(builtPlans);
      selfHolder.tools = [...selfNoteTools(notes), ...planTools(builtPlans)];
      // They are hers to be told of, whoever is looking at the page (ADR-58): the same `blocked` as her initiative.
      const blocked = (): boolean => voiceOpenRef.current || draftRef.current.trim() !== '' || permissionPrompts.snapshot().length > 0;
      // P6-T08 (ADR-58): her schedules, only where the store keeps them. The scheduler runs what is due
      // in this page (the core's; the companion runs its own with the page closed), and what it kept
      // is told — a notification while the page is hidden, else she says it, once she is free.
      const pageNotify = async (_job: unknown, finished: { readonly id: string; readonly summary: string }): Promise<boolean> => {
        if (document.visibilityState === 'visible' || notifications.permission() !== 'granted') return false;
        return notifications.show(pack.persona.name, finished.summary, finished.id);
      };
      const scheduling = choice.store.capabilities().then(
        (capabilities) => {
          if (!live || !capabilities.schedules) return;
          const builtSchedules = new Schedules({
            store: choice.store,
            characterId: pack.persona.id,
            timeZone,
            companion: choice.kind === 'companion',
            toolNames: () => chatTools().map((tool) => tool.definition.name),
          });
          selfHolder.schedules = builtSchedules;
          setSchedules(builtSchedules);
          scheduler = attachScheduler({
            store: choice.store,
            characterId: pack.persona.id,
            runner: 'core',
            execute: agentExecutor({ llm: rawLlm, modelId, character: { name: pack.persona.name, summary: pack.persona.summary }, tools: chatTools }),
            notify: pageNotify,
            scheduler: hostTimers(),
            onRun: () => void builtSchedules.load().catch(() => undefined),
            onError: (error) => warn(error, 'schedules'),
          });
          selfHolder.tools = [...selfHolder.tools, ...scheduleTools({ schedules: builtSchedules, runNow: (id) => scheduler?.runNow(id) ?? Promise.resolve(null), timeZone })];
          deliveries = attachDeliveries(machine, {
            schedules: builtSchedules,
            chat,
            blocked,
            visible: () => document.visibilityState === 'visible',
            notify: pageNotify,
            timeZone,
            scheduler: hostTimers(),
            onError: (error) => warn(error, 'schedules'),
          });
        },
        (error: unknown) => warn(error instanceof Error ? error : new Error(String(error)), 'schedules'),
      );
      mood = attachMood(machine, { affect, notes, onError: (error) => warn(error, 'mood') });
      window.addEventListener('pagehide', saveMood);
      // P6-T02 (ADR-51): when they last talked, then — with her notes, plans and facts in — whether
      // she speaks first. A store that cannot say leaves both out.
      const last = lastConversation(choice.store, pack.persona.id, sessionId).catch((error: unknown) => {
        warn(error instanceof Error ? error : new Error(String(error)), 'last conversation');
        return null;
      });
      const memoryReady = attached.settled();
      void Promise.all([last, notesLoaded, plansLoaded, memoryReady, scheduling]).then(async ([since]) => {
        if (!live) return;
        timeHolder.since = since;
        // P6-T03 (ADR-52): her initiative — the opener if they came back after an hour (ADR-51),
        // then check-ins — on the dial in Settings, read each time, and a budget kept with her notes.
        initiative = attachInitiative(machine, {
          chat,
          dial: () => loadSettings(deps.storage).initiative,
          blocked,
          followUps: () => builtPlans.promptContext().followUps,
          plans: () => builtPlans.snapshot().plans,
          facts: () => attached?.context()?.facts ?? [],
          ledger: { read: () => notes.system(INITIATIVE_BLOCK), write: (text) => notes.writeSystem(INITIATIVE_BLOCK, text) },
          scheduler: hostTimers(),
          onError: (error) => warn(error, 'initiative'),
        });
        // A reminder that came due while they were away is said before anything else: they asked for
        // it, and the opener (ADR-51) is not asked for on top of it. It is outside the initiative's
        // dial and budget (ADR-58).
        const said = (await deliveries?.tick()) ?? false;
        if (!live) return;
        if (!said) initiative.open(since);
        // P6-T04 (ADR-53): after ten quiet minutes with something new to sort, she rests and
        // sleeps on it; anything — the bus, a key, a press — wakes her.
        resting = attachRest(machine, {
          kernel,
          blocked,
          ledger: { read: () => notes.system(REST_BLOCK), write: (text) => notes.writeSystem(REST_BLOCK, text) },
          scheduler: hostTimers(),
          onError: (error) => warn(error, 'sleep'),
        });
        stopResting = resting.subscribe(setRestingNow);
        window.addEventListener('keydown', wakeHer);
        window.addEventListener('pointerdown', wakeHer);
        setRest(resting);
      });
    });
    return () => {
      live = false;
      initiative?.detach();
      deliveries?.detach();
      scheduler?.detach();
      stopResting();
      resting?.detach();
      window.removeEventListener('keydown', wakeHer);
      window.removeEventListener('pointerdown', wakeHer);
      setRest(null);
      setRestingNow(false);
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
      selfHolder.schedules = null;
      setSchedules(null);
      selfHolder.tools = [];
      timeHolder.since = null;
    };
  }, [affect, chat, chatTools, chooseMemory, companionUrl, deps.fetch, deps.storage, machine, memoryHolder, modelId, notifications, pack.persona.id, pack.persona.name, pack.persona.summary, permissionPrompts, rawLlm, selfHolder, sessionId, settings.memory, timeHolder, timeZone, userAffect]);

  // MCP servers (P5-T01, ADR-42): connected once per visit from Settings → Tools. One that
  // fails offers no tools, and the transcript says so — the person added it expecting it to work.
  useEffect(() => {
    let live = true;
    let connected: ConnectedToolServer[] = [];
    void connectTools({
      servers: settings.tools.servers,
      loadKey: (ref) => deps.vault.loadKey(ref),
      // P5-T02 (ADR-43): the companion's own servers, when Settings → Tools turned them on.
      companion: settings.tools.companion ? { baseUrl: companionUrl } : null,
    }).then((result) => {
      if (!live) {
        for (const server of result.connected) void server.client.close();
        return;
      }
      connected = result.connected;
      toolsHolder.servers = result.connected;
      for (const status of result.statuses.filter((candidate) => !candidate.ok)) {
        machine.dispatch({ type: 'error', sessionId, at: new Date().toISOString(), scope: 'tool', message: `${status.label} could not be reached (${status.detail}), so its tools are off this visit.` });
      }
    });
    return () => {
      live = false;
      toolsHolder.servers = [];
      for (const server of connected) void server.client.close();
    };
  }, [companionUrl, connectTools, deps.vault, machine, sessionId, settings.tools.companion, settings.tools.servers, toolsHolder]);

  // Her documents (P5-T04, ADR-45): only when Settings → Documents turned searching on — no
  // unasked request to the companion. On and not working, the transcript says why.
  useEffect(() => {
    if (!settings.documents.search) return undefined;
    let live = true;
    void connectDocs({ companionUrl, fetch: deps.fetch }).then((connected) => {
      if (!live) return;
      docsHolder.connected = connected;
      if (connected.notice !== null) machine.dispatch({ type: 'error', sessionId, at: new Date().toISOString(), scope: 'tool', message: connected.notice });
    });
    return () => {
      live = false;
      docsHolder.connected = null;
    };
  }, [companionUrl, connectDocs, deps.fetch, docsHolder, machine, sessionId, settings.documents.search]);
  const citationSource = useCallback((ref: string) => docsHolder.connected?.sources.get(ref) ?? webSources.get(ref), [docsHolder, webSources]);

  // `stop`, not `dispose`: StrictMode runs this cleanup once on mount in development, and a
  // disposed session refuses every later message — the page would never answer.
  useEffect(() => () => chat.stop(), [chat]);

  const subscribe = useMemo(() => (listener: (event: ConversationEvent) => void) => machine.subscribe(listener), [machine]);
  const { lines, clear } = useTranscript(subscribe);

  // The room's boards (P5-T08, ADR-49): the whiteboard shows the plan in focus (else the newest
  // that is not archived), the screen the sources of her latest cited answer.
  const subscribePlans = useCallback((listener: () => void) => plans?.subscribe(listener) ?? (() => {}), [plans]);
  const plansSnapshot = useCallback(() => plans?.snapshot() ?? null, [plans]);
  const planState = useSyncExternalStore(subscribePlans, plansSnapshot);
  const displays = useMemo<Displays>(() => {
    const plan = planState === null ? null : pickPlan(planState.plans, planState.focusId);
    return { whiteboard: plan === null ? null : planToWhiteboard(plan), screen: sourcesToScreen(latestCitedSources(lines, citationSource)) };
  }, [planState, lines, citationSource]);

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
  const [drawerView, setDrawerView] = useState<'transcript' | 'memory' | 'plans' | 'schedules' | 'thoughts'>('transcript');
  /** The Transcript, Memory, Plans and Thoughts buttons share this: pressing the view already showing
   * closes the drawer, pressing the other switches to it (opening the drawer if closed). */
  const toggleDrawerView = useCallback(
    (view: 'transcript' | 'memory' | 'plans' | 'schedules' | 'thoughts') => {
      if (drawerOpen && drawerView === view) {
        setDrawerOpen(false);
        return;
      }
      setDrawerView(view);
      setDrawerOpen(true);
    },
    [drawerOpen, drawerView],
  );
  // P6-T05 (ADR-54): her lines are only asked of the model while the Thoughts view is showing.
  const thoughtsShowing = drawerOpen && drawerView === 'thoughts';
  useEffect(() => {
    inner.look(thoughtsShowing);
  }, [inner, thoughtsShowing]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const userCamera = useUserCamera(cameraDeps);

  // Typed replies spoken aloud (P2-T08). `speaker` is state for the stage's lip sync;
  // `speakerRef` is the same object for teardown, which must not wait on a render.
  // Her voice (P6-T06, ADR-55): the settings the speaker and the voice panel get have this character's
  // voice in them — the one saved for her on this engine, else her persona's, else the one in Voice.
  const voiceSettings = useMemo(() => withCharacterVoice(settings, pack.persona), [settings, pack]);
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
        const started = await loader.start({ settings: voiceSettings, deps, consent: deps.consent });
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
    [affect, chat, deps, voiceSettings],
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
    const models = loader.voiceModelsFor(voiceSettings);
    if (deps.consent.has(models)) {
      await startSpeaking(loader);
    } else {
      setSpeakConsent({ loader, models });
      setSpeak('consent');
    }
  }, [deps.consent, loadSpeaker, voiceSettings, speak, startSpeaking, stopSpeaking]);

  /** A call brings its own voice, and two would load Kokoro twice: speaking typed replies
   * ends when a call begins. */
  const openVoice = useCallback(() => {
    stopSpeaking();
    voiceOpenRef.current = true;
    setVoiceOpen(true);
  }, [stopSpeaking]);

  const onVoiceEnd = useCallback(() => {
    voiceOpenRef.current = false;
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
      draftRef.current = '';
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
          avatar={pack.avatar}
          avatarDescriptor={pack.avatarDescriptor}
          consent={deps.consent}
          createRenderer={createRenderer}
          displays={displays}
          listening={listening}
          rest={rest}
          machine={machine}
          voice={voiceOutput}
        />
      </Suspense>

      {restingNow && (
        <p className="call-rest-indicator" role="status">
          {pack.persona.name} is resting, sorting through what you have talked about
        </p>
      )}

      {showAffectOverlay && <AffectOverlay affect={affect} listening={listening.reactor} userAffect={userAffect} />}

      <aside className={`call-drawer ${drawerOpen ? '' : 'call-drawer-closed'}`} hidden={!drawerOpen}>
        {drawerView === 'memory' ? (
          <MemoryPanel characterName={pack.persona.name} memory={memory} subscribe={subscribe} where={memoryWhere} />
        ) : drawerView === 'plans' ? (
          <PlansPanel characterName={pack.persona.name} plans={plans} />
        ) : drawerView === 'schedules' ? (
          <SchedulesPanel characterName={pack.persona.name} notifications={notifications} schedules={schedules} timeZone={timeZone} />
        ) : drawerView === 'thoughts' ? (
          <InnerPanel characterName={pack.persona.name} inner={inner} />
        ) : (
          <TranscriptPanel characterName={pack.persona.name} lines={lines} onClear={clear} sources={citationSource} />
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
              settings={voiceSettings}
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
            intro={`${pack.persona.name} can watch your expression through your camera to tell how you seem. A model running in this browser reads each frame and drops it at once: no frame is saved or sent anywhere, and only a mood estimate is kept. It is off until you turn it on, and a light on your picture shows while it runs. Agreeing turns on the camera and downloads this model:`}
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
            onChange={(event) => {
              setDraft(event.target.value);
              draftRef.current = event.target.value;
            }}
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

      {/* After the docks it may sit above: the stylesheet lifts it clear of whichever is open. */}
      <PermissionPrompt characterName={pack.persona.name} prompts={permissionPrompts} />

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
        <select
          aria-label="Talking to"
          className="select call-character-select"
          disabled={voiceOpen || busy}
          onChange={(event) => onSwitch(event.target.value)}
          title="Who you are talking to. Switching starts a new visit."
          value={pack.persona.id}
        >
          {PACKS.map((candidate) => (
            <option key={candidate.persona.id} value={candidate.persona.id}>
              {candidate.persona.name}
            </option>
          ))}
        </select>
        <button aria-pressed={drawerOpen && drawerView === 'transcript'} className="btn call-control-btn" onClick={() => toggleDrawerView('transcript')} type="button">
          Transcript
        </button>
        <button aria-pressed={drawerOpen && drawerView === 'memory'} className="btn call-control-btn" onClick={() => toggleDrawerView('memory')} type="button">
          Memory
        </button>
        <button aria-pressed={drawerOpen && drawerView === 'plans'} className="btn call-control-btn" onClick={() => toggleDrawerView('plans')} type="button">
          Plans
        </button>
        <button aria-pressed={drawerOpen && drawerView === 'schedules'} className="btn call-control-btn" onClick={() => toggleDrawerView('schedules')} type="button">
          Schedules
        </button>
        <button aria-pressed={thoughtsShowing} className="btn call-control-btn" onClick={() => toggleDrawerView('thoughts')} title="Her private thoughts — never said aloud" type="button">
          Thoughts
        </button>
        <a className="btn btn-ghost call-control-btn" href="/settings">
          Settings
        </a>
      </div>
    </main>
  );
}
