import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConversationMachine } from '@latentpresence/core';
import type { ConversationState } from '@latentpresence/protocol';
import type { CharacterSource, ExpressionWeights, ModelDescriptor, Viseme } from '@latentpresence/protocol';
import {
  BaseClipGraph,
  CuePerformer,
  LifeLayer,
  TagBridge,
  withGesture,
  LipSync,
  MOUTH_SHAPES,
  tapAnalyser,
  type CameraPreset,
  type LifePose,
} from '@latentpresence/avatar';
import { VrmAvatarRenderer } from '@latentpresence/avatar/vrm';
import { cachedModelFetch, type ModelConsent } from '@latentpresence/ml-web/consent';
import { ConsentScreen } from '../consent/ConsentScreen';
import type { ActiveCall } from '../voice/VoicePanel';
import { AVATAR, AVATAR_DESCRIPTOR } from './character-asset';
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
 * the avatar moves until `AVATAR_DESCRIPTOR` is granted in `ModelConsent`, the same
 * `latentpresence.consent.v1` store the voice models share. A returning user who already
 * granted it never sees the panel.
 *
 * **Lip sync follows the call** (decision 5): `call` is `null` between calls, and whatever
 * `VoicePanel` hands `/chat` through `onCallStarted` while one is running. `call.output` is
 * optional on `ActiveCall` for a test call with no audio graph; this component treats a
 * call with no `output` the same as no call at all.
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
  /** P2-T03's base clips. `loadClip` is VRM-only; a renderer without it plays no clips. */
  loadClip?(id: string, url: string): Promise<void>;
  playClip?(id: string, options: { loop: boolean; crossfadeMs: number; weight: number }): Promise<void>;
}

export interface CallStageProps {
  readonly machine: ConversationMachine;
  /** The shared consent book (`deps.consent` — the same object `/settings` and the voice
   * panel read and revoke). */
  readonly consent: ModelConsent;
  /** The running call, for lip sync, or `null` between calls. */
  readonly call: ActiveCall | null;
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

const defaultCreateRenderer = (): CallStageRenderer => new VrmAvatarRenderer();

export function CallStage({ machine, consent, call, createRenderer = defaultCreateRenderer, fetchModel = cachedModelFetch }: CallStageProps): ReactElement {
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

  // A previously granted descriptor skips the panel entirely — read once, not watched:
  // consent granted mid-session (there is no UI for that here) would not retroactively
  // start a fetch this render already decided against.
  const [phase, setPhase] = useState<CharacterPhase>(() => (consent.has([AVATAR_DESCRIPTOR]) ? 'loading' : 'consent'));
  const [status, setStatus] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    readyRef.current = phase === 'ready';
  }, [phase]);

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
    const unsubscribe = machine.subscribe((event) => {
      bridge.handle(event, performance.now());
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
        const cues = performer.update(delta);
        avatar.setLifePose?.(withGesture(life.update(delta), cues.additive));
        avatar.setExpression(cues.expression);
        const lipSync = lipSyncRef.current;
        if (lipSync !== null) {
          for (const [shape, weight] of lipSync.update(delta, now)) avatar.setViseme(shape, weight);
        }
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
      unsubscribe();
      cancelAnimationFrame(frame);
      avatar.dispose();
      rendererRef.current = null;
    };
    // `createRenderer` is a stable identity in production (the module-level default) and
    // in a test (the seam a test passes once); `machine` lives for the page's life.
  }, [machine, createRenderer]);

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

  // Fetches and loads the character, but only once `phase` says consent is in hand —
  // `fetchModel` is not called from anywhere else in this component, which is the whole
  // proof "nothing fetched before consent" needs.
  useEffect(() => {
    if (!mounted || phase !== 'loading') return;
    let cancelled = false;
    void (async () => {
      const avatar = rendererRef.current;
      if (avatar === null) return;
      try {
        const bytes = await fetchModel(AVATAR.downloadUrl, AVATAR_DESCRIPTOR);
        if (cancelled) return;
        const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
        try {
          await avatar.loadCharacter({ id: 'placeholder', url: blobUrl, format: 'vrm', licence: AVATAR.licence, attribution: AVATAR.author });
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        if (cancelled) return;
        // The clips come after the character: `loadClip` retargets onto whichever model is
        // loaded. A clip that fails leaves her standing in the life layer's rest pose, which
        // is how she stood before P2-T03 — a note, not a failure.
        if (avatar.loadClip !== undefined) {
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
  }, [mounted, phase, fetchModel, machine]);

  // Follows `call`: taps the voice's output node for lip sync while one is running, and
  // shuts the mouth again — every viseme to 0 — the moment it is not (decision 5).
  useEffect(() => {
    const output = call?.output;
    if (output === undefined) {
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
  }, [call]);

  function agree(): void {
    consent.grant([AVATAR_DESCRIPTOR]);
    setPhase('loading');
  }

  function notNow(): void {
    setPhase('declined');
  }

  function reopen(): void {
    setPhase('consent');
  }

  return (
    <div className="call-stage">
      <canvas className="call-stage-canvas" ref={canvasRef} />
      {phase === 'consent' && (
        <div className="call-stage-overlay">
          <ConsentScreen
            agreeLabel="Show the character"
            cancelLabel="Not now"
            descriptors={[AVATAR_DESCRIPTOR]}
            heading="This will download the character"
            intro="This comes from GitHub to this computer. It stays in this browser — nothing is sent anywhere."
            onAgree={agree}
            onCancel={notNow}
          />
        </div>
      )}
      {phase === 'declined' && (
        <div className="call-stage-overlay call-stage-overlay-minimal">
          <button className="btn btn-ghost" onClick={reopen} type="button">
            Show the character
          </button>
        </div>
      )}
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
