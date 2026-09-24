import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { DEFAULT_SER_MODEL, createGatedSerWorker, serModels, type SerModelKey } from '@latentpresence/ml-web';
import { SpeechEmotionReader } from '@latentpresence/providers';
import { ConsentScreen } from '../consent/ConsentScreen';
import { defaultSettingsDeps } from '../settings/deps';

/**
 * `/dev/ser` (P3-T05): voice emotion in a real browser worker, timed. The done-when is
 * *"inference under 150 ms per segment in a worker"*, and a node run on wasm cannot say
 * that — this page loads a model through the same gated worker the call will use and times
 * segments of 1 to 6 seconds (base hears the last 1.5 s, the distill two 3 s windows). The audio is a voiced-like signal, not speech: cost depends on length, not on
 * what is said. **Record 3 s** reads the microphone once, so a person can check the label.
 *
 * Results are hung on `globalThis.serBench` for a script to read; that name is also the
 * build guard's needle for this page (`vite.config.ts`).
 */

interface Row {
  readonly model: SerModelKey;
  readonly seconds: number;
  readonly median: number;
  readonly p90: number;
  readonly max: number;
}

const RUNS = 10;
const RATE = 16_000;

/** Harmonics under a slow vibrato: enough like a voice to give the model something to chew. */
function segment(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    const f = 180 + 20 * Math.sin(2 * Math.PI * 4 * t);
    out[i] = 0.1 * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t));
  }
  return out;
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

async function recordThreeSeconds(): Promise<Float32Array> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const context = new AudioContext({ sampleRate: RATE });
  const source = context.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  const processor = context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(context.destination);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  processor.disconnect();
  source.disconnect();
  for (const track of stream.getTracks()) track.stop();
  await context.close();
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function SerBench(): ReactElement {
  const [deps] = useState(defaultSettingsDeps);
  const [model, setModel] = useState<SerModelKey>(DEFAULT_SER_MODEL);
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState('Nothing loaded.');
  const [rows, setRows] = useState<Row[]>([]);
  const [heard, setHeard] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reader = useRef<SpeechEmotionReader | null>(null);

  useEffect(() => () => reader.current?.terminate(), []);
  useEffect(() => {
    (globalThis as { serBench?: unknown }).serBench = { rows, status, heard };
  }, [rows, status, heard]);

  const run = useCallback(async () => {
    setAsking(false);
    reader.current?.terminate();
    const current = new SpeechEmotionReader({ createWorker: () => createGatedSerWorker(deps.consent, model), model });
    reader.current = current;
    setLoaded(false);
    try {
      setStatus(`Loading ${model} on ${current.backend}…`);
      const started = performance.now();
      await current.load();
      setLoaded(true);
      setStatus(`Loaded ${model} on ${current.backend} in ${Math.round(performance.now() - started)} ms (warm-up included). Timing…`);
      const measured: Row[] = [];
      for (const seconds of [1, 1.5, 2, 3, 6]) {
        const times: number[] = [];
        for (let i = 0; i < RUNS; i += 1) times.push((await current.read(segment(seconds))).inferenceMs);
        const sorted = times.toSorted((a, b) => a - b);
        measured.push({ model, seconds, median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted.at(-1) ?? 0 });
        setRows((previous) => [...previous.filter((row) => !(row.model === model && row.seconds === seconds)), ...measured.slice(-1)]);
      }
      setStatus(`Done: ${model} on ${current.backend}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [deps.consent, model]);

  const start = useCallback(() => {
    if (deps.consent.has(serModels(model))) void run();
    else setAsking(true);
  }, [deps.consent, model, run]);

  const listen = useCallback(async () => {
    const current = reader.current;
    if (current === null) return;
    setHeard('Recording 3 s…');
    const reading = await current.read(await recordThreeSeconds());
    const top = Object.entries(reading.probabilities)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, p]) => `${label} ${p.toFixed(2)}`)
      .join(', ');
    setHeard(`${reading.label} (confidence ${reading.confidence.toFixed(2)}, ${Math.round(reading.inferenceMs)} ms) — ${top}`);
  }, []);

  return (
    <main className="spike">
      <header className="spike-header">
        <h1>Voice emotion — worker timing (P3-T05)</h1>
        <p className="spike-status">{status}</p>
      </header>
      <div className="spike-controls">
        <select className="select" onChange={(event) => setModel(event.target.value as SerModelKey)} value={model}>
          <option value="distill">distill (wasm, 9.7 MB) — default</option>
          <option value="base">emotion2vec+ base (WebGPU, 373 MB, last 1.5 s)</option>
        </select>
        <button className="btn btn-primary" onClick={start} type="button">
          Load and time
        </button>
        <button className="btn" disabled={!loaded} onClick={() => void listen()} type="button">
          Record 3 s
        </button>
      </div>
      {asking && (
        <ConsentScreen
          descriptors={serModels(model)}
          onAgree={() => {
            deps.consent.grant(serModels(model));
            void run();
          }}
          onCancel={() => setAsking(false)}
        />
      )}
      <table className="spike-results">
        <thead>
          <tr>
            <th>model</th>
            <th>segment</th>
            <th>median ms</th>
            <th>p90 ms</th>
            <th>max ms</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.model}-${row.seconds}`}>
              <td>{row.model}</td>
              <td>{row.seconds} s</td>
              <td>{row.median.toFixed(1)}</td>
              <td>{row.p90.toFixed(1)}</td>
              <td>{row.max.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {heard !== null && <p className="spike-status">Heard: {heard}</p>}
    </main>
  );
}
