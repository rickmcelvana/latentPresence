import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  type ConversationState,
  ConversationStateSchema,
  type ExpressionName,
  ExpressionNameSchema,
  type ExpressionWeights,
  type GazeTarget,
  GazeTargetSchema,
} from '@latentpresence/protocol';
import { type ExpressionPlan, LifeLayer, MOUTH_SHAPES, type MouthShape } from '@latentpresence/avatar';
import { VrmAvatarRenderer } from '@latentpresence/avatar/vrm';
import { AVATAR, AVATAR_ASSETS, IDLE_CLIP, totalAssetBytes } from '../spikes/avatar-consent';

/**
 * `/dev/avatar` (P2-T01): the VRM renderer behind a debug panel — every expression name
 * the protocol has, what it resolved to on the loaded model, the five mouth shapes, the
 * gaze targets and the one VRMA clip there is.
 *
 * The done-when is "the sample VRM shows all presets", and **Cycle presets** is that in
 * one button: each preset at full weight for a second, in turn, so a person can watch the
 * whole set without dragging fourteen sliders.
 *
 * **Life (P2-T02)** runs the procedural layer — breathing, blinks, gaze, weight shifts —
 * with a conversation-state select, a live readout, and **Record 60 s**, which captures
 * the canvas to a webm for the done-when's review. With life on, the gaze select below
 * sets the base the eyes return to rather than a fixed target.
 *
 * Spike B's `/spike/avatar` stays beside it: that page is the frame-rate instrument R-1
 * runs on another machine, and this one measures nothing.
 */

type Phase = 'consent' | 'loading' | 'ready' | 'failed';

const CLIP_ID = 'test';
const PRESETS: readonly ExpressionName[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const CYCLE_MS = 1000;
const RECORD_MS = 60_000;

interface LifeReadout {
  readonly seconds: number;
  readonly blinks: number;
  readonly gaze: string;
}

type Recording =
  | { readonly kind: 'idle' }
  | { readonly kind: 'recording' }
  | { readonly kind: 'done'; readonly url: string; readonly bytes: number }
  | { readonly kind: 'failed'; readonly reason: string };

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function describeTargets(plan: ExpressionPlan | null, name: ExpressionName): string {
  const targets = plan?.get(name);
  if (targets === undefined) return '';
  if (targets.length === 0) return 'nothing on this model';
  return targets
    .map((target) => (target.scale === 1 ? target.name : `${target.name} ×${target.scale}`))
    .join(', ');
}

export function AvatarDebug(): ReactElement {
  const [phase, setPhase] = useState<Phase>('consent');
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState('Waiting for consent.');
  const [expression, setExpression] = useState<ExpressionWeights>({});
  const [mouth, setMouth] = useState<Record<MouthShape, number>>({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
  const [gaze, setGaze] = useState<GazeTarget>('user');
  const [cycling, setCycling] = useState<ExpressionName | null>(null);
  const [modelExpressions, setModelExpressions] = useState<readonly string[]>([]);
  const [plan, setPlan] = useState<ExpressionPlan | null>(null);

  const [lifeOn, setLifeOn] = useState(true);
  const [lifeState, setLifeState] = useState<ConversationState>('listening');
  const [readout, setReadout] = useState<LifeReadout>({ seconds: 0, blinks: 0, gaze: 'user' });
  const [recording, setRecording] = useState<Recording>({ kind: 'idle' });

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const renderer = useRef<VrmAvatarRenderer | null>(null);
  const life = useRef<LifeLayer | null>(null);
  /** Read by the frame loop, which must not restart on every toggle. */
  const lifeOnRef = useRef(lifeOn);
  const live = useRef(false);
  const counters = useRef({ ms: 0, blinks: 0, lastBlink: 0, gaze: 'user' });

  // One renderer for the page's life, driven by the browser's frame loop: the interface
  // says `update` belongs to the render loop, not to a timer inside the renderer.
  useEffect(() => {
    const surface = canvas.current;
    if (!started || surface === null) return;
    const avatar = new VrmAvatarRenderer();
    renderer.current = avatar;
    // StrictMode runs this twice in development; the first run's load is still in flight
    // when its cleanup disposes it, and must not start a loop or report a failure.
    let cancelled = false;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const delta = now - last;
      const layer = life.current;
      if (live.current && lifeOnRef.current && layer !== null) {
        const pose = layer.update(delta);
        avatar.setLifePose(pose);
        const c = counters.current;
        c.ms += delta;
        if (c.lastBlink < 0.5 && pose.blink >= 0.5) c.blinks += 1;
        c.lastBlink = pose.blink;
        c.gaze = pose.gaze.target;
      }
      avatar.update(delta);
      last = now;
      frame = requestAnimationFrame(tick);
    };

    void (async () => {
      try {
        await avatar.mount(surface);
        if (cancelled) return;
        frame = requestAnimationFrame(tick);
        await avatar.loadCharacter({
          id: 'placeholder',
          url: AVATAR.downloadUrl,
          format: 'vrm',
          licence: AVATAR.licence,
          attribution: AVATAR.author,
        });
        if (cancelled) return;
        setModelExpressions(avatar.modelExpressions());
        setPlan(avatar.expressionPlan());
        try {
          await avatar.loadClip(CLIP_ID, IDLE_CLIP.downloadUrl);
        } catch (error) {
          // A missing clip is a note, not a failure: the face is what this page is for.
          setStatus(`Clip failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (cancelled) return;
        live.current = true;
        setPhase('ready');
        setStatus((previous) => (previous.startsWith('Clip failed') ? previous : 'Ready.'));
      } catch (error) {
        if (cancelled) return;
        setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
        setPhase('failed');
      }
    })();

    return () => {
      cancelled = true;
      live.current = false;
      cancelAnimationFrame(frame);
      avatar.dispose();
      renderer.current = null;
    };
  }, [started]);

  // While cycling, one preset at full weight overrides the sliders; after, they apply again.
  const driven = useMemo<ExpressionWeights>(
    () => (cycling === null ? expression : { [cycling]: 1 }),
    [cycling, expression],
  );

  useEffect(() => {
    if (phase === 'ready') renderer.current?.setExpression(driven);
  }, [driven, phase]);

  // One life layer for the page; made in an effect rather than during render.
  useEffect(() => {
    life.current = new LifeLayer();
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    lifeOnRef.current = lifeOn;
    // With life on, the select is the base the eyes return to; off, it is where they are.
    if (lifeOn) {
      life.current?.setGazeBase(gaze);
    } else {
      renderer.current?.setLifePose(null);
      renderer.current?.setGaze(gaze);
    }
  }, [gaze, lifeOn, phase]);

  useEffect(() => {
    life.current?.setState(lifeState);
  }, [lifeState]);

  // The frame loop counts; this samples it twice a second rather than re-rendering the
  // page sixty times.
  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = setInterval(() => {
      const c = counters.current;
      setReadout({ seconds: c.ms / 1000, blinks: c.blinks, gaze: c.gaze });
    }, 500);
    return () => clearInterval(timer);
  }, [phase]);

  const resetCounts = useCallback(() => {
    counters.current = { ms: 0, blinks: 0, lastBlink: 0, gaze: counters.current.gaze };
    setReadout({ seconds: 0, blinks: 0, gaze: counters.current.gaze });
  }, []);

  /**
   * Sixty seconds of the canvas as a webm, for the done-when's review. `captureStream`
   * records what WebGL draws, and the file is a local download — nothing is uploaded.
   */
  const record = useCallback(() => {
    const surface = canvas.current;
    if (surface === null) return;
    try {
      const stream = surface.captureStream(30);
      const vp9 = 'video/webm;codecs=vp9';
      const mimeType = MediaRecorder.isTypeSupported(vp9) ? vp9 : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        setRecording({ kind: 'done', url: URL.createObjectURL(blob), bytes: blob.size });
      };
      recorder.start(1000);
      setRecording({ kind: 'recording' });
      resetCounts();
      setTimeout(() => recorder.stop(), RECORD_MS);
    } catch (error) {
      setRecording({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }, [resetCounts]);

  useEffect(() => {
    return () => {
      if (recording.kind === 'done') URL.revokeObjectURL(recording.url);
    };
  }, [recording]);

  useEffect(() => {
    if (phase !== 'ready') return;
    for (const shape of MOUTH_SHAPES) renderer.current?.setViseme(shape, mouth[shape]);
  }, [mouth, phase]);

  // Cycle presets: each at full weight for a second, in turn.
  useEffect(() => {
    if (cycling === null) return;
    const timer = setTimeout(() => setCycling(PRESETS[PRESETS.indexOf(cycling) + 1] ?? null), CYCLE_MS);
    return () => clearTimeout(timer);
  }, [cycling]);

  const playClip = useCallback((loop: boolean) => {
    const avatar = renderer.current;
    if (avatar === null) return;
    setStatus(loop ? 'Clip looping.' : 'Clip playing once…');
    avatar
      .playClip(CLIP_ID, { loop, crossfadeMs: 250, weight: 1 })
      .then(() => {
        if (!loop) setStatus('Clip finished.');
      })
      .catch((error: unknown) => setStatus(`Clip: ${error instanceof Error ? error.message : String(error)}`));
  }, []);

  const ready = phase === 'ready';
  const phaseTone = phase === 'failed' ? 'pill-danger' : ready ? 'pill-ok' : '';

  return (
    <div className="spike">
      <header className="spike-header">
        <h1>Avatar — VRM renderer debug panel</h1>
        <p className="panel-note">
          P2-T01&apos;s <code>VrmAvatarRenderer</code> on the placeholder character. Every
          expression the protocol names, with what it resolved to on this model; the five
          mouth shapes; the gaze targets; and a VRMA clip. Measures nothing — the frame-rate
          page is <code>/spike/avatar</code>.
        </p>
      </header>

      {phase === 'consent' ? (
        <section className="panel spike-consent">
          <div className="panel-header">
            <span className="panel-title">This will download assets</span>
            <span className="pill pill-accent">{formatMb(totalAssetBytes(AVATAR_ASSETS))} total</span>
          </div>
          <p className="panel-note">
            Nothing has been fetched yet. The character carries the VRM Public License 1.0,
            not Creative Commons, which is why it is downloaded rather than kept in this
            repository.
          </p>
          <ul className="spike-models">
            {AVATAR_ASSETS.map((asset) => (
              <li className="spike-model" key={asset.downloadUrl}>
                <span className="spike-model-name">{asset.label}</span>
                <span className="spike-model-meta">
                  {formatMb(asset.bytes)} · {asset.licence} · {asset.author} ·{' '}
                  <a href={asset.sourceUrl} rel="noreferrer" target="_blank">
                    source
                  </a>
                </span>
              </li>
            ))}
          </ul>
          <div className="spike-controls">
            <button
              className="btn btn-primary"
              onClick={() => {
                setPhase('loading');
                setStarted(true);
                setStatus('Fetching the avatar.');
              }}
              type="button"
            >
              Agree and download
            </button>
          </div>
        </section>
      ) : null}

      {/* Rendered from the commit that sets `started`, so the canvas ref is in place by the
          time the renderer's effect reads it. */}
      {started ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Stage</span>
            <span className={`pill ${phaseTone}`}>{phase}</span>
          </div>
          <p className="spike-status">{status}</p>
          <div className="avatar-debug-stage">
            <canvas className="avatar-debug-canvas" ref={canvas} />
          </div>
          <p className="panel-note">
            Model expressions: {modelExpressions.length === 0 ? '—' : modelExpressions.join(', ')}
          </p>
        </section>
      ) : null}

      {ready ? (
        <>
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Expressions</span>
              {cycling === null ? null : <span className="pill pill-accent">{cycling}</span>}
            </div>
            <div className="spike-controls">
              <button className="btn" disabled={cycling !== null} onClick={() => setCycling('neutral')} type="button">
                Cycle presets
              </button>
              <button className="btn btn-ghost" onClick={() => setExpression({})} type="button">
                Reset
              </button>
            </div>
            <div className="avatar-debug-grid">
              {ExpressionNameSchema.options.map((name) => (
                <label className="field" key={name}>
                  <span className="field-label">{name}</span>
                  <input
                    disabled={cycling !== null}
                    max={1}
                    min={0}
                    onChange={(event) => setExpression((previous) => ({ ...previous, [name]: Number(event.target.value) }))}
                    step={0.05}
                    type="range"
                    value={expression[name] ?? 0}
                  />
                  <span className="field-hint">→ {describeTargets(plan, name)}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Mouth</span>
            </div>
            <div className="avatar-debug-grid">
              {MOUTH_SHAPES.map((shape) => (
                <label className="field" key={shape}>
                  <span className="field-label">{shape}</span>
                  <input
                    max={1}
                    min={0}
                    onChange={(event) => setMouth((previous) => ({ ...previous, [shape]: Number(event.target.value) }))}
                    step={0.05}
                    type="range"
                    value={mouth[shape]}
                  />
                </label>
              ))}
            </div>
            <div className="spike-controls">
              <button className="btn btn-ghost" onClick={() => setMouth({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 })} type="button">
                sil (close)
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Gaze and clips</span>
            </div>
            <div className="spike-controls">
              <label className="field">
                <span className="field-label">Gaze</span>
                <select className="select" onChange={(event) => setGaze(event.target.value as GazeTarget)} value={gaze}>
                  {GazeTargetSchema.options.map((target) => (
                    <option key={target} value={target}>
                      {target}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn" onClick={() => playClip(false)} type="button">
                Play clip once
              </button>
              <button className="btn btn-ghost" onClick={() => playClip(true)} type="button">
                Loop clip
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Life</span>
              <span className={`pill ${lifeOn ? 'pill-ok' : ''}`}>{lifeOn ? 'on' : 'off'}</span>
            </div>
            <p className="panel-note">
              Breathing, blinks, gaze that looks away and comes back, and weight shifts, with no
              clip playing. Rates follow the conversation state. The arms come down from the
              T-pose only while no clip is posing the body.
            </p>
            <div className="spike-controls">
              <label className="field">
                <span className="field-label">Life layer</span>
                <select
                  className="select"
                  onChange={(event) => setLifeOn(event.target.value === 'on')}
                  value={lifeOn ? 'on' : 'off'}
                >
                  <option value="on">on</option>
                  <option value="off">off (frozen, for comparison)</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Conversation state</span>
                <select
                  className="select"
                  onChange={(event) => setLifeState(event.target.value as ConversationState)}
                  value={lifeState}
                >
                  {ConversationStateSchema.options.map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn btn-primary"
                disabled={recording.kind === 'recording'}
                onClick={record}
                type="button"
              >
                {recording.kind === 'recording' ? 'Recording…' : 'Record 60 s'}
              </button>
              <button className="btn btn-ghost" onClick={resetCounts} type="button">
                Reset counts
              </button>
            </div>
            <p className="spike-status">
              {readout.seconds.toFixed(0)} s · {readout.blinks} blinks
              {readout.seconds >= 10 ? ` (${((readout.blinks * 60) / readout.seconds).toFixed(1)}/min)` : ''}
              {' · gaze '}
              {readout.gaze}
            </p>
            {recording.kind === 'done' ? (
              <p className="panel-note">
                <a download={`avatar-life-${lifeState}.webm`} href={recording.url}>
                  Save the recording
                </a>{' '}
                ({formatMb(recording.bytes)}) — a local file; nothing was uploaded.
              </p>
            ) : null}
            {recording.kind === 'failed' ? (
              <p className="field-error">Recording failed: {recording.reason}</p>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
