import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { FACE_FEATURES, FaceAffectReader, type FaceReading } from '@latentpresence/core';
import { createGatedFaceWorker, faceModels, type FaceDelegate } from '@latentpresence/ml-web';
import { FaceExpressionReader } from '@latentpresence/providers';
import { ConsentScreen } from '../consent/ConsentScreen';
import { defaultSettingsDeps } from '../settings/deps';
import { scoreFaceSet, type FaceSample, type FaceScoreRow } from './face-score';

declare const FACE_SET_DIR: string;

/**
 * `/dev/face` (P3-T06): the face landmarker in its real worker, on either delegate.
 *
 * - **Time** runs the generated set's pictures through the worker and reports the model's
 *   time per frame.
 * - **Score the set** reads every picture once and scores the heuristic against each
 *   person's own neutral picture (`face-score.ts`). The set is `pnpm live:face-set`'s
 *   output in `live/out/faces`, served through Vite's `/@fs/`.
 * - **Camera** reads the live camera, for a person to make faces at: the reading, and the
 *   features behind it.
 *
 * Results hang on `globalThis.faceBench`, also the build guard's needle for this page.
 */

interface Manifest {
  readonly file: string;
  readonly person: number;
  readonly label: string;
}

const LABELS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'disgusted', 'fearful'];

async function loadImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return createImageBitmap(await response.blob());
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

export function FaceBench(): ReactElement {
  const [deps] = useState(defaultSettingsDeps);
  const [delegate, setDelegate] = useState<FaceDelegate>('GPU');
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState('Nothing loaded.');
  const [timing, setTiming] = useState<string | null>(null);
  const [samples, setSamples] = useState<FaceSample[]>([]);
  const [rows, setRows] = useState<FaceScoreRow[]>([]);
  const [live, setLive] = useState<{ reading: FaceReading | null; features: Record<string, number> } | null>(null);
  const reader = useRef<FaceExpressionReader | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<{ stream: MediaStream; timer: ReturnType<typeof setInterval> } | null>(null);
  const clock = useRef(0);

  const stopCamera = useCallback(() => {
    const camera = cameraRef.current;
    if (camera === null) return;
    clearInterval(camera.timer);
    for (const track of camera.stream.getTracks()) track.stop();
    cameraRef.current = null;
  }, []);

  useEffect(
    () => () => {
      stopCamera();
      reader.current?.terminate();
    },
    [stopCamera],
  );
  useEffect(() => {
    (globalThis as { faceBench?: unknown }).faceBench = { status, timing, samples, rows };
  }, [status, timing, samples, rows]);

  const nextTimestamp = useCallback((): number => (clock.current = Math.max(clock.current + 1, Math.round(performance.now()))), []);

  const load = useCallback(async () => {
    setAsking(false);
    reader.current?.terminate();
    const current = new FaceExpressionReader({ createWorker: () => createGatedFaceWorker(deps.consent), delegates: [delegate] });
    reader.current = current;
    const started = performance.now();
    setStatus(`Loading on ${delegate}…`);
    try {
      await current.load();
      setStatus(`Loaded on ${delegate} in ${Math.round(performance.now() - started)} ms.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [delegate, deps.consent]);

  const start = useCallback(() => {
    if (deps.consent.has(faceModels())) void load();
    else setAsking(true);
  }, [deps.consent, load]);

  const readSet = useCallback(async (): Promise<{ samples: FaceSample[]; times: number[] }> => {
    const current = reader.current;
    if (current === null) throw new Error('load first');
    const manifest = (await (await fetch(`/@fs/${FACE_SET_DIR}manifest.json`)).json()) as Manifest[];
    const read: FaceSample[] = [];
    const times: number[] = [];
    for (const entry of manifest) {
      const image = await loadImage(`/@fs/${FACE_SET_DIR}${entry.file}`);
      // A picture is a still: a fresh landmarker per picture would be fair, but the
      // tracker settles in a frame or two, so read it three times and keep the last.
      let result = null;
      for (let i = 0; i < 3; i += 1) {
        const copy = await createImageBitmap(image);
        result = await current.read(copy, nextTimestamp());
        times.push(result.inferenceMs);
      }
      image.close();
      read.push({ person: entry.person, label: entry.label, blendshapes: result?.blendshapes ?? null });
      setStatus(`Read ${entry.file}`);
    }
    return { samples: read, times };
  }, [nextTimestamp]);

  const time = useCallback(async () => {
    try {
      const { times } = await readSet();
      const sorted = times.toSorted((a, b) => a - b);
      setTiming(`${delegate}: median ${percentile(sorted, 0.5).toFixed(1)} ms · p90 ${percentile(sorted, 0.9).toFixed(1)} · max ${(sorted.at(-1) ?? 0).toFixed(1)} over ${sorted.length} frames`);
      setStatus('Timed.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [delegate, readSet]);

  const score = useCallback(async () => {
    try {
      const { samples: read } = await readSet();
      setSamples(read);
      setRows(scoreFaceSet(read));
      setStatus('Scored.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [readSet]);

  const camera = useCallback(async () => {
    const current = reader.current;
    const video = videoRef.current;
    if (current === null || video === null) return;
    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = stream;
    await video.play();
    const face = new FaceAffectReader();
    let busy = false;
    const timer = setInterval(() => {
      if (busy || video.videoWidth === 0) return;
      busy = true;
      void createImageBitmap(video)
        .then((frame) => current.read(frame, nextTimestamp()))
        .then((result) => {
          const features: Record<string, number> = {};
          for (const [name, shapes] of Object.entries(FACE_FEATURES)) {
            features[name] = shapes.reduce((sum, shape) => sum + (result.blendshapes?.[shape] ?? 0), 0) / shapes.length;
          }
          setLive({ reading: face.push(result.blendshapes, performance.now()), features });
        })
        .finally(() => {
          busy = false;
        });
    }, 100);
    cameraRef.current = { stream, timer };
  }, [nextTimestamp, stopCamera]);

  const right = rows.filter((row) => row.got === row.expected).length;
  return (
    <main className="spike">
      <header className="spike-header">
        <h1>Face reading — worker and heuristic (P3-T06)</h1>
        <p className="spike-status">{status}</p>
      </header>
      <div className="spike-controls">
        <select className="select" onChange={(event) => setDelegate(event.target.value as FaceDelegate)} value={delegate}>
          <option value="GPU">GPU delegate</option>
          <option value="CPU">CPU delegate</option>
        </select>
        <button className="btn btn-primary" onClick={start} type="button">
          Load
        </button>
        <button className="btn" onClick={() => void time()} type="button">
          Time
        </button>
        <button className="btn" onClick={() => void score()} type="button">
          Score the set
        </button>
        <button className="btn" onClick={() => void camera()} type="button">
          Camera
        </button>
      </div>
      {asking && (
        <ConsentScreen
          descriptors={faceModels()}
          onAgree={() => {
            deps.consent.grant(faceModels());
            void load();
          }}
          onCancel={() => setAsking(false)}
        />
      )}
      {timing !== null && <p className="spike-status">{timing}</p>}
      <video className="face-bench-video" muted playsInline ref={videoRef} />
      {live !== null && (
        <p className="spike-status">
          {live.reading === null ? 'no face' : `${live.reading.label} (confidence ${live.reading.confidence.toFixed(2)}, v ${live.reading.valence.toFixed(2)}, a ${live.reading.arousal.toFixed(2)})`} ·{' '}
          {Object.entries(live.features)
            .map(([name, value]) => `${name} ${value.toFixed(2)}`)
            .join(' · ')}
        </p>
      )}
      {rows.length > 0 && (
        <table className="spike-results">
          <thead>
            <tr>
              <th>expected ({right}/{rows.length} right)</th>
              {LABELS.map((label) => (
                <th key={label}>{label}</th>
              ))}
              <th>no face</th>
            </tr>
          </thead>
          <tbody>
            {LABELS.map((expected) => (
              <tr key={expected}>
                <td>{expected}</td>
                {[...LABELS, 'no face'].map((got) => (
                  <td key={got}>{rows.filter((row) => row.expected === expected && row.got === got).length || ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
