import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConversationMachine } from '@latentpresence/core';
import type { ConversationState } from '@latentpresence/protocol';
import type { CharacterSource, ExpressionWeights, ModelDescriptor, UserAffect, Viseme } from '@latentpresence/protocol';
import {
  BaseClipGraph,
  CuePerformer,
  LifeLayer,
  TagBridge,
  affectToBody,
  applyListening,
  mergeExpressionsMax,
  relativeGaze,
  restFrame,
  restLevel,
  withGesture,
  LipSync,
  MOUTH_SHAPES,
  tapAnalyser,
  type AffectInputs,
  type CameraPreset,
  type Displays,
  type GazeModulation,
  type LifePose,
  type ListeningReactor,
} from '@latentpresence/avatar';
import { VrmAvatarRenderer } from '@latentpresence/avatar/vrm';
import { cachedModelFetch, type ModelConsent } from '@latentpresence/ml-web/consent';
import { ConsentScreen } from '../consent/ConsentScreen';
import type { AudioOutputHandle } from '@latentpresence/providers';
import { BUILT_IN_BODIES, builtInStageBody, type BuiltInBody, type StageBody } from '../characters/bodies';
import { IdleDirector } from './idle';
import { BASE_CLIP_URLS } from './clips';
import { computePixelRatio } from './pixel-ratio';

/**
 * The stage (P2-T06): mounts a renderer on a canvas, drives it from one `rAF` loop —
 * `LifeLayer.update` → `setLifePose`, `LipSync.update` → `setViseme`, `renderer.update`
 * — exactly the shape `apps/web/src/dev/AvatarDebug.tsx` runs, minus everything that page
 * has only for measuring itself.
 *
 * **The character is behind consent** (decision 3): the canvas mounts and the frame loop
 * starts immediately — that draws the room and the lighting, nothing else — but no byte of
 * the avatar moves until its descriptor is granted in `ModelConsent`, the same
 * `latentpresence.consent.v1` store the voice models share. A returning user who already
 * granted it never sees the panel. A person's own body (P7-T02) is already on this computer,
 * so it asks nothing.
 *
 * **The body changes live** (P7-T02, ADR-59): a new `body` loads while the one on stage keeps
 * moving, and replaces it between two frames — the renderer, the frame loop, the conversation
 * and everything attached to it stay. A body refused or failing leaves the old one standing.
 *
 * **Lip sync follows the voice** (decision 5): `voice` is the output graph of whatever is
 * speaking — a call's (`VoicePanel` hands it to `/chat` through `onCallStarted`) or, since
 * P2-T08, the speaker that reads typed replies aloud — and `null` when neither is. A test
 * call with no audio graph has no `output`, and `/chat` passes that as `null` too.
 */

/** What `CallStage` needs from a renderer — the protocol's `AvatarRenderer` plus the four
 * VRM-only methods it actually calls (`renderer.ts`'s "beyond the interface" section).
 * Declared optional here so `FakeAvatarRenderer` — which has none of them — still
 * satisfies this structurally for a test's `createRenderer` seam; `VrmAvatarRenderer`
 * always has all four, optional or not. */
export interface CallStageRenderer {
  mount(canvas: HTMLCanvasElement): Promise<void>;
  loadCharacter(source: CharacterSource): Promise<void>;
  setViseme(viseme: Viseme, weight: number): void;
  setExpression(weights: ExpressionWeights): void;
  update(deltaMs: number): void;
  dispose(): void;
  setLifePose?(pose: LifePose | null): void;
  setCameraPreset?(preset: CameraPreset, transitionMs?: number): void;
  setPixelRatio?(ratio: number): void;
  setShadows?(on: boolean): void;
  /** P5-T08: what the room's whiteboard and screen show. */
  setDisplays?(displays: Displays): void;
  /** P2-T03's base clips. `loadClip` is VRM-only; a renderer without it plays no clips. */
  loadClip?(id: string, url: string): Promise<void>;
  playClip?(id: string, options: { loop: boolean; crossfadeMs: number; weight: number }): Promise<void>;
}

/**
 * The character's mood, for the body (P3-T09): what `affectToBody` reads, now, and where
 * she rests. The gaze habit is applied **relative to the baseline**, so at rest the life
 * layer is exactly what it was before affect existed (`relativeGaze`).
 */
export interface CallStageAffect {
  inputs(): AffectInputs;
  readonly baseline: AffectInputs;
}

/**
 * How she listens (P3-T08): the reactor the call tells about pauses and loudness, and the
 * user's live fused estimate, read every frame. Her listening face goes over her own, damping
 * whatever in it would contradict the user; her nods go through the tag performer.
 */
export interface CallStageListening {
  readonly reactor: ListeningReactor;
  userAffect(): UserAffect | null;
}

export interface CallStageProps {
  readonly machine: ConversationMachine;
  /** The shared consent book (`deps.consent` — the same object `/settings` and the voice
   * panel read and revoke). */
  readonly consent: ModelConsent;
  /** The voice's output graph, for lip sync, or `null` when nothing can speak. */
  readonly voice: AudioOutputHandle | null;
  /** Her mood, read every frame; omitted or null, the stage shows tags alone, as before P3-T09. */
  readonly affect?: CallStageAffect | null;
  /** How she listens; omitted or null, she keeps the face she has while the user talks, as before P3-T08. */
  readonly listening?: CallStageListening | null;
  /** What the whiteboard and the screen in the room show (P5-T08); omitted, they stay blank and dark. */
  readonly displays?: Displays | undefined;
  /** Whether she is resting (P6-T04, ADR-53), read every frame; omitted or null, she never does. */
  readonly rest?: { resting(): boolean } | null;
  /** The body to wear (P7-T02, ADR-59: the character's choice from the library); omitted, the placeholder.
   * A new `id` swaps it live. */
  readonly body?: StageBody;
  /** Test seam: a fake renderer factory in place of `new VrmAvatarRenderer()`. Production
   * never passes it. */
  readonly createRenderer?: (() => CallStageRenderer) | undefined;
  /** Test seam: in place of `cachedModelFetch`, so a fetch spy can prove nothing moves
   * before consent without a real Cache Storage or network. */
  readonly fetchModel?: (url: string, descriptor: ModelDescriptor) => Promise<Uint8Array>;
}

/** Plays the base clip for `state` if it differs from the one playing (`BaseClipGraph`). */
function playBaseClip(avatar: CallStageRenderer, graph: BaseClipGraph, state: ConversationState): void {
  const change = graph.setState(state);
  if (change === null) return;
  void avatar.playClip?.(change.clip, { loop: true, crossfadeMs: change.crossfadeMs, weight: 1 });
}

type CharacterPhase = 'consent' | 'loading' | 'ready' | 'declined' | 'failed';

const EMPTY_DISPLAYS: Displays = { whiteboard: null, screen: null };

/** Roughly where her head is, for the angle to a prop: she stands at the origin (P2-T05). */
const IDLE_HEAD: readonly [number, number, number] = [0, 1.5, 0];

const defaultCreateRenderer = (): CallStageRenderer => new VrmAvatarRenderer();

const PLACEHOLDER: StageBody = builtInStageBody(BUILT_IN_BODIES[0] as BuiltInBody);

export function CallStage({
  machine,
  consent,
  voice,
  affect = null,
  listening = null,
  displays = EMPTY_DISPLAYS,
  rest = null,
  body: asked = PLACEHOLDER,
  createRenderer = defaultCreateRenderer,
  fetchModel = cachedModelFetch,
}: CallStageProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CallStageRenderer | null>(null);
  const lipSyncRef = useRef<LipSync | null>(null);
  /** Read by the frame loop and by the lip-sync effect, neither of which may call a
   * VRM-only method before a character is actually loaded — `VrmAvatarRenderer.setLifePose`
   * and `.setViseme` both throw against an unloaded character. */
  const readyRef = useRef(false);
  /** The body's base clip follows the conversation state (P2-T03), once the clips are in. */
  const clipsReadyRef = useRef(false);
  const graphRef = useRef(new BaseClipGraph());
  /** The mood the frame loop reads, with its baseline's gaze worked out once. */
  const affectRef = useRef<{ source: CallStageAffect; baselineGaze: GazeModulation } | null>(null);
  const listeningRef = useRef<CallStageListening | null>(null);
  /** What the boards show, for the idle planner (P6-T01): reading a blank board is not a thing to do. */
  const displaysRef = useRef<Displays>(displays);
  const restRef = useRef<{ resting(): boolean } | null>(rest);

  /** The latest body asked for, for the load effect, which runs per body id rather than per object. */
  const bodyRef = useRef(asked);
  /** Whether the clips have been fetched; a later body only has them retargeted. */
  const clipsLoadedRef = useRef(false);

  // A previously granted descriptor skips the panel entirely — read when a body is asked for,
  // not watched: consent granted elsewhere mid-session would not retroactively start a fetch
  // this render already decided against.
  const firstPhase = (wanted: StageBody): CharacterPhase => (wanted.kind === 'local' || consent.has([wanted.descriptor]) ? 'loading' : 'consent');
  const [request, setRequest] = useState(() => ({ id: asked.id, phase: firstPhase(asked) }));
  let phase = request.phase;
  if (request.id !== asked.id) {
    // A new body asked for: its own consent or load starts, while the old one stays on stage.
    const next = { id: asked.id, phase: firstPhase(asked) };
    setRequest(next);
    phase = next.phase;
  }
  const setPhase = useCallback((next: CharacterPhase): void => setRequest((current) => ({ ...current, phase: next })), []);
  /** The body on stage, once there is one: the overlays speak of a swap rather than a first load. */
  const [onStage, setOnStage] = useState<string | null>(null);

  useEffect(() => {
    bodyRef.current = asked;
  }, [asked]);
  const [status, setStatus] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    affectRef.current = affect === null ? null : { source: affect, baselineGaze: affectToBody(affect.baseline).gaze };
  }, [affect]);

  useEffect(() => {
    displaysRef.current = displays;
  }, [displays]);

  useEffect(() => {
    restRef.current = rest;
  }, [rest]);

  useEffect(() => {
    listeningRef.current = listening;
    listening?.reactor.setState(machine.getState());
  }, [listening, machine]);

  // One renderer for the stage's life: mounts the canvas and starts the frame loop right
  // away (the room and its lighting need no consent), and follows the conversation state
  // into the life layer via `machine.subscribe` (decision 4).
  useEffect(() => {
    const surface = canvasRef.current;
    if (surface === null) return;
    const avatar = createRenderer();
    rendererRef.current = avatar;
    avatar.setCameraPreset?.('medium', 0);

    const life = new LifeLayer();
    life.setState(machine.getState());
    // P2-T07: the model's [emote:] and [gesture:] tags, placed on the words they were
    // written before, from the sentence timing each `assistant.audio.started` carries.
    const performer = new CuePerformer();
    const bridge = new TagBridge(performer);
    // P6-T01 (ADR-50): her own idle life. Anything on the bus but the affect engines' own ticks,
    // or a key or a press anywhere on the page, means someone is there: she stops at once.
    const idle = new IdleDirector();
    let idleEmote = false;
    let idleMouth = 0;
    // P6-T04 (ADR-53): how far into her rest she is, 0 awake to 1 asleep.
    let resting = 0;
    const wake = (): void => idle.activity();
    window.addEventListener('keydown', wake);
    window.addEventListener('pointerdown', wake);
    const unsubscribe = machine.subscribe((event) => {
      if (event.type !== 'affect.user.updated' && event.type !== 'affect.character.updated') idle.activity();
      bridge.handle(event, performance.now());
      listeningRef.current?.reactor.onEvent(event, performance.now());
      if (event.type !== 'state.changed') return;
      life.setState(event.to);
      if (clipsReadyRef.current) playBaseClip(avatar, graphRef.current, event.to);
    });

    // StrictMode runs this effect's cleanup once in development before the mount promise
    // below resolves; `cancelled` keeps that run from starting a loop on a disposed
    // renderer (the same guard `AvatarDebug`'s mount effect uses).
    let cancelled = false;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const delta = now - last;
      last = now;
      bridge.update(now);
      if (readyRef.current) {
        // P3-T08: her reaction to the user, first, so a nod it starts moves this frame.
        const listen = listeningRef.current;
        const reaction = listen === null ? null : listen.reactor.update(now, listen.userAffect());
        for (const gesture of reaction?.gestures ?? []) performer.perform({ kind: 'gesture', value: gesture, known: gesture, offset: 0 });
        // P6-T01: what she does of her own, before the cue performer steps, so its gesture moves this frame.
        // P6-T04: resting, her idle life waits — the rest is held, eyes closed, head a little down.
        const asleep = restRef.current?.resting() === true;
        resting = restLevel(resting, asleep, delta);
        if (asleep) idle.activity();
        const inputs = affectRef.current?.source.inputs() ?? null;
        const shown = displaysRef.current;
        const idling = idle.update(
          delta,
          { state: machine.getState(), pleasure: inputs?.mood.pleasure ?? 0, energy: inputs?.energy ?? 0.5, showing: { whiteboard: shown.whiteboard !== null, screen: shown.screen !== null }, now: new Date() },
          IDLE_HEAD,
        );
        if (idling.cues?.gesture != null) performer.perform({ kind: 'gesture', value: idling.cues.gesture, known: idling.cues.gesture, offset: 0 });
        if (idling.cues?.emote != null) {
          performer.perform({ kind: 'emote', value: idling.cues.emote, known: idling.cues.emote, offset: 0 });
          idleEmote = true;
        }
        if (idling.ended && idleEmote) {
          performer.release();
          idleEmote = false;
        }
        life.setGazeBase(asleep ? 'down' : (idling.gazeBase ?? 'user'));
        const cues = performer.update(delta);
        // P3-T09: the mood's resting face under the tags' faces, and its gaze habit on the
        // life layer — both before `life.update`, which reads the modulation this frame.
        const mood = affectRef.current;
        let face = cues.expression;
        if (mood !== null) {
          const body = affectToBody(mood.source.inputs());
          life.setModulation(relativeGaze(body.gaze, mood.baselineGaze));
          face = mergeExpressionsMax(body.expression, cues.expression);
        } else {
          life.setModulation(null);
        }
        if (reaction !== null) face = applyListening(face, reaction);
        let pose = withGesture(withGesture(life.update(delta), cues.additive), idling.additive);
        if (idling.lookAt !== null || idling.eyesClosed > 0) {
          pose = { ...pose, blink: Math.max(pose.blink, idling.eyesClosed), gaze: idling.lookAt === null ? pose.gaze : { ...pose.gaze, point: idling.lookAt } };
        }
        if (resting > 0) {
          const settled = restFrame(resting);
          pose = { ...withGesture(pose, settled.additive), blink: Math.max(pose.blink, settled.eyesClosed) };
        }
        avatar.setLifePose?.(pose);
        avatar.setExpression(face);
        const lipSync = lipSyncRef.current;
        if (lipSync !== null) {
          for (const [shape, weight] of lipSync.update(delta, now)) avatar.setViseme(shape, weight);
        }
        // A yawn's jaw (P6-T01), after lip sync so it wins, and back to closed once it is over.
        if (idling.mouthOpen > 0 || idleMouth > 0) avatar.setViseme('aa', idling.mouthOpen);
        idleMouth = idling.mouthOpen;
      }
      avatar.update(delta);
      frame = requestAnimationFrame(tick);
    };

    void (async () => {
      try {
        await avatar.mount(surface);
        if (cancelled) return;
        frame = requestAnimationFrame(tick);
        setMounted(true);
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof Error ? error.message : String(error));
        setPhase('failed');
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('keydown', wake);
      window.removeEventListener('pointerdown', wake);
      unsubscribe();
      cancelAnimationFrame(frame);
      avatar.dispose();
      rendererRef.current = null;
      readyRef.current = false;
      clipsReadyRef.current = false;
      clipsLoadedRef.current = false;
    };
    // `createRenderer` is a stable identity in production (the module-level default) and
    // in a test (the seam a test passes once); `machine` lives for the page's life.
  }, [machine, createRenderer, setPhase]);

  // The room's whiteboard and screen (P5-T08): pushed when the content changes, and once the
  // renderer is mounted (they are part of the room, so they need no character).
  useEffect(() => {
    if (!mounted) return;
    rendererRef.current?.setDisplays?.(displays);
  }, [displays, mounted]);

  // The drawing buffer's pixel ratio (decision 10): applied once the surface is mounted,
  // and re-applied on every resize so a window dragged onto a 4K monitor is not stuck at
  // the ratio it opened with.
  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    const avatar = rendererRef.current;
    if (canvas === null || avatar === null) return;
    const apply = (): void => {
      avatar.setPixelRatio?.(computePixelRatio(canvas.clientWidth, window.devicePixelRatio || 1));
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [mounted]);

  // Fetches and loads the body, but only once `phase` says consent is in hand —
  // `fetchModel` is not called from anywhere else in this component, which is the whole
  // proof "nothing fetched before consent" needs.
  useEffect(() => {
    const wanted = bodyRef.current;
    if (!mounted || phase !== 'loading' || wanted.id !== request.id) return;
    let cancelled = false;
    void (async () => {
      const avatar = rendererRef.current;
      if (avatar === null) return;
      try {
        const bytes = wanted.kind === 'download' ? await fetchModel(wanted.asset.downloadUrl, wanted.descriptor) : await wanted.read();
        if (cancelled) return;
        const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
        try {
          await avatar.loadCharacter(
            wanted.kind === 'download'
              ? { id: wanted.id, url: blobUrl, format: 'vrm', licence: wanted.asset.licence, attribution: wanted.asset.author }
              : { id: wanted.id, url: blobUrl, format: 'vrm', licence: 'Your own file', attribution: null },
          );
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        if (cancelled) return;
        readyRef.current = true;
        // The clips come after the first body: `loadClip` retargets onto whichever model is
        // loaded, and the renderer retargets them again onto every later one, so a swap only
        // starts the base clip afresh on the new body. A clip that fails leaves her standing in
        // the life layer's rest pose, which is how she stood before P2-T03 — a note, not a failure.
        if (clipsLoadedRef.current) {
          if (clipsReadyRef.current) {
            graphRef.current.reset();
            playBaseClip(avatar, graphRef.current, machine.getState());
          }
        } else if (avatar.loadClip !== undefined) {
          clipsLoadedRef.current = true;
          try {
            await Promise.all(Object.entries(BASE_CLIP_URLS).map(([id, url]) => avatar.loadClip?.(id, url)));
            if (cancelled) return;
            graphRef.current.reset();
            clipsReadyRef.current = true;
            playBaseClip(avatar, graphRef.current, machine.getState());
          } catch (error) {
            console.warn('Base clips failed to load; standing in the rest pose.', error);
          }
        }
        if (cancelled) return;
        setOnStage(wanted.id);
        setPhase('ready');
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof Error ? error.message : String(error));
        setPhase('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
    // `request.id`, not the body: a new object for the same body is not a new load.
  }, [mounted, phase, fetchModel, machine, request.id, setPhase]);

  // Follows `voice`: taps its output node for lip sync while there is one, and shuts the
  // mouth again — every viseme to 0 — the moment there is not (decision 5).
  useEffect(() => {
    const output = voice;
    if (output === null) {
      lipSyncRef.current = null;
      const avatar = rendererRef.current;
      if (avatar !== null && readyRef.current) for (const shape of MOUTH_SHAPES) avatar.setViseme(shape, 0);
      return;
    }
    const tapped = tapAnalyser(output.context, output.node);
    lipSyncRef.current = new LipSync(tapped);
    return () => {
      tapped.disconnect();
      lipSyncRef.current = null;
      const avatar = rendererRef.current;
      if (avatar !== null && readyRef.current) for (const shape of MOUTH_SHAPES) avatar.setViseme(shape, 0);
    };
  }, [voice]);

  function agree(): void {
    if (asked.kind === 'download') consent.grant([asked.descriptor]);
    setPhase('loading');
  }

  function notNow(): void {
    setPhase('declined');
  }

  function reopen(): void {
    setPhase(firstPhase(asked));
  }

  const swapping = onStage !== null;

  return (
    <div className="call-stage">
      <canvas className="call-stage-canvas" ref={canvasRef} />
      {phase === 'consent' && asked.kind === 'download' && (
        <div className="call-stage-overlay">
          <ConsentScreen
            agreeLabel={swapping ? 'Wear this body' : 'Show the character'}
            cancelLabel="Not now"
            descriptors={[asked.descriptor]}
            heading={swapping ? 'This will download a new body' : 'This will download the character'}
            intro="This comes from GitHub to this computer. It stays in this browser — nothing is sent anywhere."
            onAgree={agree}
            onCancel={notNow}
          />
        </div>
      )}
      {phase === 'declined' && (
        <div className="call-stage-overlay call-stage-overlay-minimal">
          <button className="btn btn-ghost" onClick={reopen} type="button">
            {swapping ? `Wear ${asked.name}` : 'Show the character'}
          </button>
        </div>
      )}
      {phase === 'loading' && swapping && <p className="call-stage-note">Changing into {asked.name}…</p>}
      {phase === 'failed' && (
        <div className="call-stage-overlay call-stage-overlay-minimal">
          <p className="field-error">{status}</p>
          <button className="btn btn-ghost" onClick={reopen} type="button">
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
