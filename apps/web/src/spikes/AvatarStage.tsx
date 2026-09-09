import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, type VRM } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import { Lipsync } from 'wawa-lipsync';
import { smoothWeight, toVrmViseme, visemeWeight, VRM_VISEMES } from '@latentpresence/avatar';
import { AVATAR, AVATAR_ASSETS, IDLE_CLIP, totalAssetBytes } from './avatar-consent';
import { FrameRecorder, type FrameResult } from './frame-rate';

/**
 * Spike B: a VRM 1.0 avatar in react-three-fiber, with its mouth driven by audio.
 *
 * Throwaway measurement code, like Spikes A and D — except the viseme mapping, which
 * lives in `packages/avatar` because P2 keeps it. This page exists to produce the frame
 * rates in `docs/spikes/B-vrm-lipsync.md` and to prove three things can be made to work
 * together at all: three-vrm, react-three-fiber under React 19, and a lip-sync analyser
 * that speaks a different viseme language than VRM does.
 */

/**
 * Video-call framing, which is what this product is (CLAUDE.md). Fixed, because the frame
 * rate of a 400 px viewport says nothing about a stage, and a number without the size it
 * was measured at is not a number.
 */
const STAGE_WIDTH = 960;
const STAGE_HEIGHT = 540;

/** How hard to push `features.volume` before it counts as an open mouth. */
const MOUTH_GAIN = 3;

type Phase = 'consent' | 'loading' | 'ready';
type Power = 'high-performance' | 'low-power';

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function fps(value: number): string {
  return value.toFixed(1);
}

interface Loaded {
  readonly vrm: VRM;
  readonly animation: VRMAnimation | null;
  readonly loadMs: number;
}

async function loadAvatar(onProgress: (line: string) => void): Promise<Loaded> {
  const startedAt = performance.now();
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const gltf = await loader.loadAsync(AVATAR.downloadUrl);
  const vrm = gltf.userData['vrm'] as VRM;
  onProgress(`avatar loaded in ${Math.round(performance.now() - startedAt)} ms`);

  let animation: VRMAnimation | null = null;
  try {
    const clipGltf = await loader.loadAsync(IDLE_CLIP.downloadUrl);
    animation = ((clipGltf.userData['vrmAnimations'] as VRMAnimation[] | undefined) ?? [])[0] ?? null;
    onProgress(animation === null ? 'clip loaded but contained no VRM animation' : 'clip loaded');
  } catch (error) {
    // A missing clip is a finding, not a crash: the avatar is the thing being measured.
    onProgress(`clip failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { vrm, animation, loadMs: performance.now() - startedAt };
}

/**
 * The scene. Everything that runs per frame lives here, including the frame recorder, so
 * what is measured is the loop that actually draws.
 */
function Stage({
  loaded,
  lipsync,
  recorder,
  onRenderer,
}: {
  loaded: Loaded;
  lipsync: Lipsync | null;
  recorder: FrameRecorder;
  onRenderer: (description: string) => void;
}): ReactElement {
  const { scene, camera, gl } = useThree();
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  /** Current weight per VRM viseme, so the mouth is smoothed rather than snapped. */
  const weights = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const vrm = loaded.vrm;
    scene.add(vrm.scene);

    // Frame the head and shoulders, the way a call does. `getNormalizedBoneNode` is the
    // VRM 1.0 way to find a bone without knowing what the rig called it.
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    const target = new THREE.Vector3();
    head?.getWorldPosition(target);
    camera.position.set(0, target.y, 1.6);
    camera.lookAt(0, target.y - 0.05, 0);

    if (loaded.animation !== null) {
      mixer.current = new THREE.AnimationMixer(vrm.scene);
      mixer.current.clipAction(createVRMAnimationClip(loaded.animation, vrm)).play();
    }

    const context = gl.getContext();
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug
      ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : String(context.getParameter(context.RENDERER));
    onRenderer(renderer);

    return () => {
      scene.remove(vrm.scene);
      mixer.current?.stopAllAction();
      mixer.current = null;
    };
  }, [camera, gl, loaded, onRenderer, scene]);

  useFrame((_state, delta) => {
    const deltaMs = delta * 1000;
    mixer.current?.update(delta);

    if (lipsync !== null) {
      lipsync.processAudio();
      const spoken = toVrmViseme(String(lipsync.viseme));
      const volume = lipsync.features?.volume ?? 0;
      const target = visemeWeight(volume, MOUTH_GAIN);

      // Every viseme is driven every frame, not just the winner: a shape left at its last
      // weight is a mouth stuck in the previous sound.
      for (const viseme of VRM_VISEMES) {
        if (viseme === 'sil') continue;
        const next = smoothWeight(
          weights.current.get(viseme) ?? 0,
          viseme === spoken ? target : 0,
          deltaMs,
        );
        weights.current.set(viseme, next);
        loaded.vrm.expressionManager?.setValue(viseme, next);
      }
    }

    // After the expressions, so spring bones and constraints settle on this frame's pose.
    loaded.vrm.update(delta);
    recorder.mark(performance.now());
  });

  return (
    <>
      <ambientLight intensity={1.1} />
      <directionalLight intensity={1.6} position={[1, 2, 3]} />
      <directionalLight intensity={0.5} position={[-2, 1, -1]} />
    </>
  );
}

export function AvatarStage(): ReactElement {
  const [phase, setPhase] = useState<Phase>('consent');
  const [power, setPower] = useState<Power>('high-performance');
  const [status, setStatus] = useState('Waiting for consent.');
  const [log, setLog] = useState<readonly string[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [result, setResult] = useState<FrameResult | null>(null);
  const [renderer, setRenderer] = useState('unknown');
  /**
   * The canvas's real backing store, read from the DOM at reading time.
   *
   * Asked-for and got are different things: a container that clamps the stage would
   * otherwise let the write-up quote a frame rate against a size it was never measured
   * at. Read rather than derived, so a mismatch is visible instead of assumed.
   */
  const [canvasSize, setCanvasSize] = useState<readonly [number, number] | null>(null);
  const [adapter, setAdapter] = useState('not queried');
  /**
   * State rather than a ref: the scene reads it while rendering, and a ref read during
   * render is a value React has not been told about — the mouth would stay dead until
   * something else happened to re-render the page.
   */
  const [lipsync, setLipsync] = useState<Lipsync | null>(null);

  const recorder = useMemo(() => new FrameRecorder(), []);
  const audio = useRef<HTMLAudioElement | null>(null);

  const say = useCallback((line: string) => {
    setLog((previous) => [...previous.slice(-40), line]);
  }, []);

  const accept = useCallback(() => {
    setPhase('loading');
    setStatus('Fetching the avatar. First run downloads it.');
    void (async () => {
      try {
        const next = await loadAvatar(say);
        setLoaded(next);
        setPhase('ready');
        setStatus('Rendering. Start the microphone or load an audio file to see the mouth.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        say(`load failed: ${message}`);
        setStatus('Load failed — see the log.');
        setPhase('consent');
      }
    })();
  }, [say]);

  /**
   * Which adapter the browser gives for this power preference.
   *
   * Reported through WebGPU because WebGL's `WEBGL_debug_renderer_info` is masked in
   * current Chrome and returns a generic string. Both are shown: if the two disagree, or
   * if `low-power` returns the same adapter as `high-performance`, the write-up says so
   * rather than printing the discrete number under an integrated heading.
   */
  useEffect(() => {
    void (async () => {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
      if (gpu === undefined) {
        setAdapter('WebGPU not available, so the adapter cannot be named');
        return;
      }
      const found = await gpu.requestAdapter({ powerPreference: power });
      const info = found?.info;
      setAdapter(
        found === undefined || found === null
          ? `no adapter for ${power}`
          : `${info?.vendor ?? '?'} / ${info?.architecture ?? '?'}${info?.device ? ` / ${info.device}` : ''}`,
      );
    })();
  }, [power]);

  const startMicrophone = useCallback(() => {
    void (async () => {
      try {
        const analyser = new Lipsync({ fftSize: 2048, historySize: 60 });
        await analyser.connectMicrophone();
        setLipsync(analyser);
        say('microphone connected to the analyser');
        setStatus('Speak — the mouth follows the microphone.');
      } catch (error) {
        say(`microphone failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [say]);

  const playFile = useCallback(
    (file: File) => {
      const element = audio.current ?? new Audio();
      audio.current = element;
      element.src = URL.createObjectURL(file);
      element.loop = true;
      const analyser = new Lipsync({ fftSize: 2048, historySize: 60 });
      analyser.connectAudio(element);
      void element.play();
      setLipsync(analyser);
      say(`playing ${file.name} through the analyser`);
    },
    [say],
  );

  useEffect(() => {
    const element = audio.current;
    return () => {
      element?.pause();
    };
  }, []);

  const asMarkdown = (): string => {
    const stats = result?.measured === true ? result.stats : null;
    return [
      `### ${power} · asked for ${STAGE_WIDTH}×${STAGE_HEIGHT} · dpr ${window.devicePixelRatio}`,
      '',
      `- canvas actually rendered at: ${canvasSize === null ? 'not read' : `${canvasSize[0]}×${canvasSize[1]}`}`,
      `- WebGL renderer: ${renderer}`,
      `- WebGPU adapter for this preference: ${adapter}`,
      `- avatar load: ${loaded === null ? 'n/a' : `${Math.round(loaded.loadMs)} ms`}`,
      `- VRMA clip: ${loaded?.animation === null ? 'loaded no animation' : 'loaded'}`,
      stats === null
        ? `- **not measured** (${result?.measured === false ? `${result.frames} of ${result.needed} frames` : 'no window yet'})`
        : `- **median ${fps(stats.medianFps)} fps, 5th percentile ${fps(stats.fifthPercentileFps)} fps** over ${stats.frames} frames`,
      stats === null
        ? ''
        : `- median frame ${stats.medianFrameMs.toFixed(1)} ms, worst frame ${stats.worstFrameMs.toFixed(1)} ms`,
    ].join('\n');
  };

  const stats = result?.measured === true ? result.stats : null;
  const smooth = stats !== null && stats.fifthPercentileFps >= 30;

  return (
    <div className="spike">
      <header className="spike-header">
        <h1>Spike B — VRM avatar and lip sync</h1>
        <p className="panel-note">
          A VRM 1.0 character with MToon materials, spring bones and node constraints, in
          react-three-fiber, at {STAGE_WIDTH}×{STAGE_HEIGHT}. The mouth is driven by
          wawa-lipsync, whose fifteen Oculus visemes are mapped onto VRM&apos;s five in
          <code> packages/avatar</code>. Median fps is the headline; the 5th percentile is
          the one that decides whether it feels smooth.
        </p>
      </header>

      {phase === 'consent' ? (
        <section className="panel spike-consent">
          <div className="panel-header">
            <span className="panel-title">This will download assets</span>
            <span className="pill pill-accent">
              {formatMb(totalAssetBytes(AVATAR_ASSETS))} total
            </span>
          </div>
          <p className="panel-note">
            Nothing has been fetched yet. The character is <strong>not</strong> under a
            Creative Commons licence — it carries the VRM Public License 1.0, which is why
            it is downloaded rather than kept in this repository. It is a placeholder until
            Alice arrives in P7-T02.
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
                  <br />
                  {asset.terms}
                </span>
              </li>
            ))}
          </ul>

          <div className="spike-controls">
            <label className="field">
              <span className="field-label">GPU preference</span>
              <select
                className="select"
                onChange={(event) => setPower(event.target.value as Power)}
                value={power}
              >
                <option value="high-performance">high-performance (discrete)</option>
                <option value="low-power">low-power (integrated, if there is one)</option>
              </select>
            </label>
          </div>

          <div className="spike-controls">
            <button className="btn btn-primary" onClick={accept} type="button">
              Agree and download
            </button>
          </div>
        </section>
      ) : null}

      {phase !== 'consent' ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {power} · {STAGE_WIDTH}×{STAGE_HEIGHT}
            </span>
            {stats === null ? (
              <span className="pill">measuring…</span>
            ) : (
              <span className={`pill ${smooth ? 'pill-ok' : 'pill-warn'}`}>
                {fps(stats.medianFps)} fps median · {fps(stats.fifthPercentileFps)} 5th pct
              </span>
            )}
          </div>
          <p className="spike-status">{status}</p>

          <div className="spike-stage" style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT }}>
            {loaded === null ? null : (
              <Canvas
                camera={{ fov: 30, near: 0.1, far: 20 }}
                // Remounted when the preference changes: a WebGL context cannot be moved
                // to another adapter, so reusing it would report the first one forever.
                key={power}
                gl={{ antialias: true, powerPreference: power }}
              >
                <Stage
                  loaded={loaded}
                  lipsync={lipsync}
                  onRenderer={setRenderer}
                  recorder={recorder}
                />
              </Canvas>
            )}
          </div>

          <div className="spike-controls">
            <label className="field">
              <span className="field-label">GPU preference</span>
              <select
                className="select"
                onChange={(event) => {
                  setPower(event.target.value as Power);
                  recorder.reset();
                  setResult(null);
                }}
                value={power}
              >
                <option value="high-performance">high-performance (discrete)</option>
                <option value="low-power">low-power (integrated, if there is one)</option>
              </select>
            </label>
            <button className="btn btn-primary" onClick={startMicrophone} type="button">
              Drive the mouth from the microphone
            </button>
            <label className="field">
              <span className="field-label">…or an audio file</span>
              <input
                accept="audio/*"
                className="input"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) playFile(file);
                }}
                type="file"
              />
            </label>
            <button
              className="btn btn-ghost"
              onClick={() => {
                recorder.reset();
                setResult(null);
                say('frame window reset');
              }}
              type="button"
            >
              Reset the window
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                const canvas = document.querySelector('.spike-stage canvas');
                if (canvas instanceof HTMLCanvasElement) {
                  setCanvasSize([canvas.width, canvas.height]);
                }
                setResult(recorder.summary());
              }}
              type="button"
            >
              Take the reading
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void navigator.clipboard.writeText(asMarkdown())}
              type="button"
            >
              Copy results as Markdown
            </button>
          </div>

          <p className="panel-note">
            WebGL renderer: {renderer} · WebGPU adapter for this preference: {adapter}
            {canvasSize === null ? '' : ` · canvas ${canvasSize[0]}×${canvasSize[1]}`}
            {loaded === null ? '' : ` · avatar loaded in ${Math.round(loaded.loadMs)} ms`}
          </p>
        </section>
      ) : null}

      {log.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Log</span>
          </div>
          <pre className="spike-log">{log.join('\n')}</pre>
        </section>
      ) : null}
    </div>
  );
}
