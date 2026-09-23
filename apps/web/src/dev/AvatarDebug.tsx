import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  type ExpressionName,
  ExpressionNameSchema,
  type ExpressionWeights,
  type GazeTarget,
  GazeTargetSchema,
} from '@latentpresence/protocol';
import { type ExpressionPlan, MOUTH_SHAPES, type MouthShape } from '@latentpresence/avatar';
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
 * Spike B's `/spike/avatar` stays beside it: that page is the frame-rate instrument R-1
 * runs on another machine, and this one measures nothing.
 */

type Phase = 'consent' | 'loading' | 'ready' | 'failed';

const CLIP_ID = 'test';
const PRESETS: readonly ExpressionName[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const CYCLE_MS = 1000;

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

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const renderer = useRef<VrmAvatarRenderer | null>(null);

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
      avatar.update(now - last);
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

  useEffect(() => {
    if (phase === 'ready') renderer.current?.setGaze(gaze);
  }, [gaze, phase]);

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
        </>
      ) : null}
    </div>
  );
}
