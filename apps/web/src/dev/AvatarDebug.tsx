import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  CharacterEmotionSchema,
  CharacterGestureSchema,
  type ConversationState,
  ConversationStateSchema,
  type ExpressionName,
  ExpressionNameSchema,
  type ExpressionWeights,
  type GazeTarget,
  GazeTargetSchema,
} from '@latentpresence/protocol';
import {
  type CameraPreset,
  CuePerformer,
  type ExpressionPlan,
  LifeLayer,
  RELEASE_AFTER_MS,
  withGesture,
  LipSync,
  MOUTH_SHAPES,
  type MouthShape,
  tapAnalyser,
} from '@latentpresence/avatar';
import { VrmAvatarRenderer } from '@latentpresence/avatar/vrm';
import { type AudioOutputHandle, createAudioOutput } from '@latentpresence/providers';
// Kokoro speech, generated for P1-T14's end-to-end test; dev-only, like this page.
import speechUrl from '../../../../e2e/fixtures/speech.wav?url';
import { type FrameResult, FrameRecorder } from '../spikes/frame-rate';
import { AVATAR, totalAssetBytes } from '../spikes/avatar-consent';
import { BASE_CLIP_URLS } from '../call/clips';

/**
 * `/dev/avatar` (P2-T01): the VRM renderer behind a debug panel — every expression name
 * the protocol has, what it resolved to on the loaded model, the five mouth shapes, the
 * gaze targets and the base clips (P2-T03: idle and talk).
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
 * **Lip sync (P2-T04)** plays Kokoro speech — or any file — through the same output graph
 * `/chat` uses (`createAudioOutput`), taps its node with an analyser and drives the mouth
 * every frame.
 *
 * **Stage (P2-T05)** is the room, three-point lighting and the four camera presets — face,
 * bust, medium, full — with eased transitions; a shadows toggle; a render scale (native or
 * a 1080 px drawing buffer); and the instrument Rick measures frame rate with: every
 * rendered frame is marked, **Take reading** reports median fps, 5th-percentile fps, the
 * worst frame and the canvas's real backing size, and changing preset, shadows or scale
 * resets the window, since a reading only means one configuration.
 *
 * Spike B's `/spike/avatar` stays beside it: that page is the frame-rate instrument R-1
 * runs on another machine, and this one measures nothing.
 */

type Phase = 'consent' | 'loading' | 'ready' | 'failed';

/** Only the character is fetched now: the clips are P2-T03's, served with the app. */
const DOWNLOADS = [AVATAR];
const CLIP_IDS = Object.keys(BASE_CLIP_URLS);
/** Every tag the model can write, for playing one by hand (P2-T07). */
const TAG_OPTIONS = [
  ...CharacterGestureSchema.options.map((value) => ({ kind: 'gesture' as const, value })),
  ...CharacterEmotionSchema.options.map((value) => ({ kind: 'emote' as const, value })),
];
const PRESETS: readonly ExpressionName[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const CYCLE_MS = 1000;
const RECORD_MS = 60_000;

const CAMERA_PRESETS: readonly CameraPreset[] = ['face', 'bust', 'medium', 'full'];
type RenderScale = 'native' | '1080p';
/** The drawing buffer's width at the 1080p render scale, whatever the canvas's CSS width is. */
const RENDER_SCALE_WIDTH_1080P = 1920;

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
  // P2-T07's performer, the same one `/chat` drives from tags, played here by hand.
  const [performer] = useState(() => new CuePerformer());
  const [tagIndex, setTagIndex] = useState(0);
  /** The sliders' face, for the frame loop to hand back when a played emote lets go. */
  const drivenRef = useRef<ExpressionWeights>({});
  /** Read by the frame loop, which must not restart on every toggle. */
  const lifeOnRef = useRef(lifeOn);
  const live = useRef(false);
  const counters = useRef({ ms: 0, blinks: 0, lastBlink: 0, gaze: 'user' });
  const [lipStatus, setLipStatus] = useState('Silent.');
  const audio = useRef<AudioOutputHandle | null>(null);
  const lips = useRef<LipSync | null>(null);

  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('bust');
  const [shadows, setShadows] = useState(true);
  const [renderScale, setRenderScale] = useState<RenderScale>('native');
  const frameRate = useRef(new FrameRecorder());
  const [reading, setReading] = useState<FrameResult | null>(null);
  const [backingSize, setBackingSize] = useState<{ readonly width: number; readonly height: number } | null>(null);

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
    /** Whether the face was the performer's last frame, so the sliders get it back once. */
    let cueFace = false;
    const tick = (now: number): void => {
      const delta = now - last;
      const layer = life.current;
      const cues = performer.update(delta);
      if (live.current) {
        const faceFromCue = Object.keys(cues.expression).length > 0;
        if (faceFromCue || cueFace) avatar.setExpression(faceFromCue ? cues.expression : drivenRef.current);
        cueFace = faceFromCue;
      }
      if (live.current && lifeOnRef.current && layer !== null) {
        const pose = layer.update(delta);
        avatar.setLifePose(withGesture(pose, cues.additive));
        const c = counters.current;
        c.ms += delta;
        if (c.lastBlink < 0.5 && pose.blink >= 0.5) c.blinks += 1;
        c.lastBlink = pose.blink;
        c.gaze = pose.gaze.target;
      }
      const lipSync = lips.current;
      if (live.current && lipSync !== null) {
        for (const [shape, weight] of lipSync.update(delta, now)) avatar.setViseme(shape, weight);
      }
      avatar.update(delta);
      // Marked here, not in `Take reading`: the instrument has to see every rendered
      // frame, not just the ones a person happens to be watching for.
      if (live.current) frameRate.current.mark(now);
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
          await Promise.all(Object.entries(BASE_CLIP_URLS).map(([id, url]) => avatar.loadClip(id, url)));
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
  }, [started, performer]);

  // While cycling, one preset at full weight overrides the sliders; after, they apply again.
  const driven = useMemo<ExpressionWeights>(
    () => (cycling === null ? expression : { [cycling]: 1 }),
    [cycling, expression],
  );

  useEffect(() => {
    drivenRef.current = driven;
    if (phase === 'ready') renderer.current?.setExpression(driven);
  }, [driven, phase]);

  const playTag = useCallback(() => {
    const option = TAG_OPTIONS[tagIndex];
    if (option === undefined) return;
    const result = performer.perform({ kind: option.kind, value: option.value, known: option.value, offset: 0 });
    setStatus(result === 'performed' ? `Playing [${option.kind}:${option.value}].` : `[${option.kind}:${option.value}] has no motion yet (needs a clip).`);
    // As after an answer: the face holds the emote, then lets go.
    if (option.kind === 'emote') setTimeout(() => performer.release(), RELEASE_AFTER_MS);
  }, [performer, tagIndex]);

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
   * The voice's output graph, made on first use from a click — a context made without a
   * gesture starts suspended — and the lip sync tapped onto it.
   */
  const ensureAudio = useCallback(async (): Promise<AudioOutputHandle> => {
    if (audio.current !== null) return audio.current;
    const handle = await createAudioOutput();
    audio.current = handle;
    lips.current = new LipSync(tapAnalyser(handle.context, handle.node));
    return handle;
  }, []);

  /**
   * Sixty seconds of the canvas, and the voice, as a webm — P2-T02's and P2-T04's reviews.
   * `captureStream` records what WebGL draws, and the file is a local download — nothing
   * is uploaded.
   */
  const record = useCallback(async () => {
    const surface = canvas.current;
    if (surface === null) return;
    try {
      const stream = surface.captureStream(30);
      // The voice goes in the same file, taken from the playback node itself, so lip sync
      // can be judged frame by frame (P2-T04). Taken before the device, so the device's own
      // output latency is not in the recording — that is the pipeline, measured alone.
      const handle = await ensureAudio();
      const voice = handle.context.createMediaStreamDestination();
      handle.node.connect(voice);
      for (const track of voice.stream.getAudioTracks()) stream.addTrack(track);
      // Both codecs named, since the stream now carries the voice as well as the canvas.
      const mimeType =
        ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'].find((type) => MediaRecorder.isTypeSupported(type)) ??
        'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.addEventListener('error', (event) => {
        const reason = (event as Event & { error?: DOMException }).error?.message ?? 'the recorder stopped';
        setRecording({ kind: 'failed', reason });
      });
      recorder.onstop = () => {
        handle.node.disconnect(voice);
        const blob = new Blob(chunks, { type: 'video/webm' });
        // MediaRecorder waits for the first video frame, audio or not: a canvas that never
        // drew — a hidden tab runs no frames — records zero bytes and raises no error
        // (measured in the Browser pane, P2-T04). Say so instead of offering an empty file.
        if (blob.size === 0) {
          setRecording({ kind: 'failed', reason: 'nothing was recorded — keep the tab visible while it runs' });
          return;
        }
        setRecording({ kind: 'done', url: URL.createObjectURL(blob), bytes: blob.size });
      };
      recorder.start(1000);
      setRecording({ kind: 'recording' });
      resetCounts();
      setTimeout(() => recorder.stop(), RECORD_MS);
    } catch (error) {
      setRecording({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }, [ensureAudio, resetCounts]);

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

  const [clipId, setClipId] = useState(CLIP_IDS[0] ?? 'idle');
  const playClip = useCallback((loop: boolean) => {
    const avatar = renderer.current;
    if (avatar === null) return;
    setStatus(loop ? 'Clip looping.' : 'Clip playing once…');
    avatar
      .playClip(clipId, { loop, crossfadeMs: 250, weight: 1 })
      .then(() => {
        if (!loop) setStatus('Clip finished.');
      })
      .catch((error: unknown) => setStatus(`Clip: ${error instanceof Error ? error.message : String(error)}`));
  }, [clipId]);

  useEffect(() => {
    if (phase === 'ready') renderer.current?.setCameraPreset(cameraPreset);
  }, [cameraPreset, phase]);

  useEffect(() => {
    if (phase === 'ready') renderer.current?.setShadows(shadows);
  }, [phase, shadows]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const surface = canvas.current;
    if (surface === null) return;
    const ratio = renderScale === '1080p' ? RENDER_SCALE_WIDTH_1080P / surface.clientWidth : window.devicePixelRatio || 1;
    renderer.current?.setPixelRatio(ratio);
  }, [phase, renderScale]);

  // A reading is only meaningful for one configuration, so each select clears the window
  // itself, from the event that changed it — not from an effect watching the new value,
  // which would fire a second render for no reason.
  const clearReading = useCallback(() => {
    frameRate.current.reset();
    setReading(null);
    setBackingSize(null);
  }, []);

  const takeReading = useCallback(() => {
    setReading(frameRate.current.summary());
    const surface = canvas.current;
    setBackingSize(surface === null ? null : { width: surface.width, height: surface.height });
  }, []);

  // The output graph is made on the first click — a context made without a gesture is
  // suspended — and closed with the page.
  useEffect(() => {
    return () => {
      lips.current = null;
      void audio.current?.close();
      audio.current = null;
    };
  }, []);

  const speak = useCallback(async (source: ArrayBuffer, label: string) => {
    try {
      const handle = await ensureAudio();
      const decoded = await handle.context.decodeAudioData(source);
      handle.output.enqueue({ samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate });
      setLipStatus(`Playing ${label} (${decoded.duration.toFixed(1)} s) through the voice's output graph.`);
    } catch (error) {
      setLipStatus(`Could not play: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [ensureAudio]);

  const speakSample = useCallback(() => {
    void (async () => speak(await (await fetch(speechUrl)).arrayBuffer(), 'the Kokoro sample'))();
  }, [speak]);

  const ready = phase === 'ready';
  const phaseTone = phase === 'failed' ? 'pill-danger' : ready ? 'pill-ok' : '';

  return (
    <div className="spike">
      <header className="spike-header">
        <h1>Avatar — VRM renderer debug panel</h1>
        <p className="panel-note">
          P2-T01&apos;s <code>VrmAvatarRenderer</code> on the placeholder character. Every
          expression the protocol names, with what it resolved to on this model; the five
          mouth shapes; the gaze targets; and the base clips. Measures nothing — the frame-rate
          page is <code>/spike/avatar</code>.
        </p>
      </header>

      {phase === 'consent' ? (
        <section className="panel spike-consent">
          <div className="panel-header">
            <span className="panel-title">This will download assets</span>
            <span className="pill pill-accent">{formatMb(totalAssetBytes(DOWNLOADS))} total</span>
          </div>
          <p className="panel-note">
            Nothing has been fetched yet. The character carries the VRM Public License 1.0,
            not Creative Commons, which is why it is downloaded rather than kept in this
            repository.
          </p>
          <ul className="spike-models">
            {DOWNLOADS.map((asset) => (
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
              <label className="field">
                <span className="field-label">Clip</span>
                <select className="select" onChange={(event) => setClipId(event.target.value)} value={clipId}>
                  {CLIP_IDS.map((id) => (
                    <option key={id} value={id}>
                      {id}
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
              <label className="field">
                <span className="field-label">Tag (P2-T07)</span>
                <select className="select" onChange={(event) => setTagIndex(Number(event.target.value))} value={tagIndex}>
                  {TAG_OPTIONS.map((option, index) => (
                    <option key={`${option.kind}:${option.value}`} value={index}>
                      {option.kind}:{option.value}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn" onClick={playTag} type="button">
                Play tag
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Lip sync</span>
            </div>
            <p className="panel-note">
              The mouth follows what the voice&apos;s output graph renders — an analyser on the
              playback worklet, the ported wawa-lipsync classifier, and smoothing that opens
              fast and closes a little slower. While audio plays it overrides the Mouth
              sliders.
            </p>
            <div className="spike-controls">
              <button className="btn btn-primary" onClick={speakSample} type="button">
                Play the Kokoro sample
              </button>
              <label className="field">
                <span className="field-label">…or your own audio</span>
                <input
                  accept="audio/*"
                  className="input"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) void file.arrayBuffer().then((bytes) => speak(bytes, file.name));
                  }}
                  type="file"
                />
              </label>
            </div>
            <p className="spike-status">{lipStatus}</p>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Stage</span>
              <span className={`pill ${shadows ? 'pill-ok' : ''}`}>{shadows ? 'shadows on' : 'shadows off'}</span>
            </div>
            <p className="panel-note">
              The room and three-point lighting (P2-T05), the four camera presets — framed
              from this model&apos;s own bones, eased between — and the instrument frame rate is
              measured with: every rendered frame is marked here, and{' '}
              <strong>Take reading</strong> reports the median, the 5th-percentile (the bad
              frames) and the single worst frame, plus the canvas&apos;s real backing size.
            </p>
            <div className="spike-controls">
              <label className="field">
                <span className="field-label">Camera</span>
                <select
                  className="select"
                  onChange={(event) => {
                    setCameraPreset(event.target.value as CameraPreset);
                    clearReading();
                  }}
                  value={cameraPreset}
                >
                  {CAMERA_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Shadows</span>
                <select
                  className="select"
                  onChange={(event) => {
                    setShadows(event.target.value === 'on');
                    clearReading();
                  }}
                  value={shadows ? 'on' : 'off'}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Render scale</span>
                <select
                  className="select"
                  onChange={(event) => {
                    setRenderScale(event.target.value as RenderScale);
                    clearReading();
                  }}
                  value={renderScale}
                >
                  <option value="native">native</option>
                  <option value="1080p">1080p</option>
                </select>
              </label>
              <button className="btn btn-primary" onClick={takeReading} type="button">
                Take reading
              </button>
              <button className="btn btn-ghost" onClick={clearReading} type="button">
                Reset
              </button>
            </div>
            {reading === null ? null : reading.measured ? (
              <p className="spike-status">
                {reading.stats.medianFps.toFixed(1)} fps median · {reading.stats.fifthPercentileFps.toFixed(1)} fps
                5th-percentile · worst frame {reading.stats.worstFrameMs.toFixed(1)} ms
                {backingSize === null ? '' : ` · ${backingSize.width}×${backingSize.height}`}
              </p>
            ) : (
              <p className="spike-status">
                Only {reading.frames} frames since the last reset — {reading.needed} needed for a reading.
              </p>
            )}
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
                onClick={() => void record()}
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
