import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Playback, startCapture, type CaptureHandle } from './audio';
import { type SpikeDtype, formatMb, modelsFor, totalBytes } from './consent';
import {
  EMPTY_MARKS,
  type TurnMarks,
  type TurnResult,
  summarise,
  timeTurn,
} from './metrics';

/**
 * Spike A: mic → VAD → STT → TTS, measured.
 *
 * Throwaway measurement code. The real pipeline is P1-T01 to P1-T08, behind the ports in
 * `packages/protocol`; this page exists to produce the numbers in
 * `docs/spikes/A-voice-loop.md` and a go/no-go, then to be deleted or promoted.
 *
 * The transcript is echoed straight back to synthesis. There is no LLM in this spike:
 * the question is what the pipeline costs *around* a model call.
 */

type Backend = 'webgpu' | 'wasm';
type Phase = 'consent' | 'loading' | 'ready' | 'listening';

interface CompletedTurn {
  readonly text: string;
  readonly result: TurnResult;
}

const BUDGET_MS = 800;

export function VoiceLoop(): ReactElement {
  const [phase, setPhase] = useState<Phase>('consent');
  const [backend, setBackend] = useState<Backend>('webgpu');
  const [dtype, setDtype] = useState<SpikeDtype>('q8');
  const [status, setStatus] = useState('Waiting for consent.');
  const [log, setLog] = useState<readonly string[]>([]);
  const [turns, setTurns] = useState<readonly CompletedTurn[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [device, setDevice] = useState<CaptureHandle | null>(null);
  const [loadMs, setLoadMs] = useState<Record<string, number>>({});
  const [heapMb, setHeapMb] = useState<number | null>(null);
  // State as well as the ref: a ref does not re-render, so the playback button would
  // stay disabled after the first recording arrived.
  const [hasRecording, setHasRecording] = useState(false);

  const vad = useRef<Worker | null>(null);
  const stt = useRef<Worker | null>(null);
  const tts = useRef<Worker | null>(null);
  const capture = useRef<CaptureHandle | null>(null);
  const playback = useRef<Playback>(new Playback());
  const marks = useRef<TurnMarks>(EMPTY_MARKS);
  const transcript = useRef('');
  /** The last utterance handed to the recogniser, kept so it can be played back. */
  const lastRecording = useRef<Float32Array | null>(null);

  const say = useCallback((line: string) => {
    setLog((previous) => [...previous.slice(-40), line]);
  }, []);

  const finishTurn = useCallback(() => {
    const result = timeTurn(marks.current);
    setTurns((previous) => [...previous, { text: transcript.current, result }]);
    marks.current = EMPTY_MARKS;
    transcript.current = '';
    setSpeaking(false);
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    if (memory) setHeapMb(Math.round(memory.usedJSHeapSize / 1_000_000));
  }, []);

  /** Wire the three workers up and load the weights. Only ever called after consent. */
  const loadModels = useCallback(() => {
    setPhase('loading');
    setStatus('Loading models. First run downloads them.');

    vad.current = new Worker(new URL('./vad.worker.ts', import.meta.url), { type: 'module' });
    stt.current = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
    tts.current = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });

    // Without these a worker that throws at load, or an unhandled rejection inside one,
    // produces no message and no error — the page simply stops mid-turn. That is what
    // the first run did: TTS died and the turn was never closed, so nothing was recorded.
    for (const [name, worker] of [
      ['VAD', vad.current],
      ['STT', stt.current],
      ['TTS', tts.current],
    ] as const) {
      worker.addEventListener('error', (event: ErrorEvent) => {
        say(`${name} worker crashed: ${event.message} (${event.filename}:${event.lineno})`);
        setStatus(`${name} worker crashed — see the log.`);
      });
      worker.addEventListener('messageerror', () => {
        say(`${name} worker could not deserialise a message`);
      });
    }

    let ready = 0;
    const oneReady = (name: string, ms?: number) => {
      ready += 1;
      if (typeof ms === 'number') setLoadMs((previous) => ({ ...previous, [name]: Math.round(ms) }));
      say(`${name} ready${typeof ms === 'number' ? ` in ${Math.round(ms)} ms` : ''}`);
      if (ready === 3) {
        setPhase('ready');
        setStatus('Models loaded. Start the microphone and say something.');
      }
    };

    vad.current.addEventListener('message', (event: MessageEvent<Record<string, unknown>>) => {
      const message = event.data;
      if (message['type'] === 'ready') {
        say(`VAD state shape ${JSON.stringify(message['stateDims'])}`);
        oneReady('VAD');
      } else if (message['type'] === 'speech-start') {
        marks.current = { ...EMPTY_MARKS, speechStart: message['at'] as number };
        setSpeaking(true);
        setStatus('Listening — you are speaking.');
      } else if (message['type'] === 'speech-end') {
        marks.current = { ...marks.current, speechEnd: message['at'] as number };
      } else if (message['type'] === 'settled') {
        marks.current = { ...marks.current, vadSettled: message['at'] as number };
        const stats = message['stats'] as {
          sampleCount: number;
          durationMs: number;
          rms: number;
          peak: number;
          maxProbability: number;
        };
        say(
          `utterance ${stats.sampleCount} samples = ${stats.durationMs} ms, ` +
            `rms ${stats.rms.toFixed(3)}, peak ${stats.peak.toFixed(3)}, ` +
            `max p(speech) ${stats.maxProbability.toFixed(2)}`,
        );
        lastRecording.current = (message['samples'] as Float32Array).slice();
        setHasRecording(true);
        setStatus('Recognising…');
        stt.current?.postMessage(
          { type: 'transcribe', samples: message['samples'] },
          [(message['samples'] as Float32Array).buffer],
        );
      } else if (message['type'] === 'error') {
        say(`VAD error: ${String(message['message'])}`);
      }
    });

    stt.current.addEventListener('message', (event: MessageEvent<Record<string, unknown>>) => {
      const message = event.data;
      if (message['type'] === 'ready') oneReady('STT', message['loadMs'] as number);
      else if (message['type'] === 'progress') setStatus(`STT ${String(message['file'])} ${String(message['percent'])}%`);
      else if (message['type'] === 'result') {
        const now = performance.now();
        const text = String(message['text']);
        transcript.current = text;
        marks.current = { ...marks.current, sttFirstResult: now, sttDone: now };
        if (text === '') {
          say('Empty transcript — turn discarded.');
          finishTurn();
          setStatus('Nothing recognised. Try again.');
          return;
        }
        say(`transcript: "${text}" — asking for synthesis`);
        setStatus(`Speaking back: "${text}"`);
        tts.current?.postMessage({ type: 'speak', text });
      } else if (message['type'] === 'error') {
        say(`STT error: ${String(message['message'])}`);
        finishTurn();
      }
    });

    tts.current.addEventListener('message', (event: MessageEvent<Record<string, unknown>>) => {
      const message = event.data;
      if (message['type'] === 'ready') oneReady('TTS', message['loadMs'] as number);
      else if (message['type'] === 'progress') setStatus(`TTS ${String(message['file'])} ${String(message['percent'])}%`);
      else if (message['type'] === 'audio') {
        say(`TTS chunk ${String(message['index'])}, ${(message['samples'] as Float32Array).length} samples`);
        const startsAt = playback.current.enqueue(
          message['samples'] as Float32Array,
          message['sampleRate'] as number,
        );
        if ((message['index'] as number) === 0) {
          marks.current = { ...marks.current, ttsFirstAudio: startsAt };
        }
      } else if (message['type'] === 'done') {
        finishTurn();
        setStatus('Listening.');
      } else if (message['type'] === 'error') {
        say(`TTS error: ${String(message['message'])}`);
        finishTurn();
      }
    });

    vad.current.postMessage({ type: 'load' });
    stt.current.postMessage({ type: 'load', device: backend, dtype });
    tts.current.postMessage({ type: 'load', device: backend, dtype });
  }, [backend, dtype, finishTurn, say]);

  const startMic = useCallback(async () => {
    const handle = await startCapture((samples, at) => {
      vad.current?.postMessage({ type: 'frame', samples, at }, [samples.buffer]);
    });
    capture.current = handle;
    setDevice(handle);
    setPhase('listening');
    setStatus('Listening.');
    say(`Mic: ${handle.deviceLabel} at ${handle.deviceSampleRate ?? '?'} Hz, graph at ${handle.graphSampleRate} Hz`);
  }, [say]);

  useEffect(() => {
    const playbackRef = playback.current;
    return () => {
      void capture.current?.stop();
      void playbackRef.close();
      vad.current?.terminate();
      stt.current?.terminate();
      tts.current?.terminate();
    };
  }, []);

  const summary = summarise(turns.map((turn) => turn.result));
  const models = modelsFor(dtype);

  const asMarkdown = () => {
    const lines = [
      `### ${backend} / ${dtype}`,
      '',
      `- device: ${device?.deviceLabel ?? 'n/a'} at ${device?.deviceSampleRate ?? '?'} Hz, graph ${device?.graphSampleRate ?? '?'} Hz`,
      `- load: ${Object.entries(loadMs).map(([k, v]) => `${k} ${v} ms`).join(', ') || 'n/a'}`,
      `- JS heap after: ${heapMb === null ? 'not reported' : `${heapMb} MB`}`,
      `- turns: ${summary.runs} (${summary.incomplete} incomplete)`,
      `- **end of speech to first audio: median ${summary.medianEndToFirstAudioMs ?? 'n/a'} ms, worst ${summary.worstEndToFirstAudioMs ?? 'n/a'} ms**`,
      `- of which hangover ${summary.medianHangoverMs ?? 'n/a'} ms, STT ${summary.medianSttMs ?? 'n/a'} ms, TTS ${summary.medianTtsMs ?? 'n/a'} ms (medians)`,
      '',
      '| # | transcript | end→audio | hangover | STT | TTS |',
      '|---|---|---|---|---|---|',
      ...turns.map((turn, i) =>
        turn.result.complete
          ? `| ${i + 1} | ${turn.text} | ${Math.round(turn.result.timing.endToFirstAudioMs)} | ${Math.round(turn.result.timing.hangoverMs)} | ${Math.round(turn.result.timing.sttMs)} | ${Math.round(turn.result.timing.ttsMs)} |`
          : `| ${i + 1} | ${turn.text} | incomplete: ${turn.result.outOfOrder ? 'out of order' : turn.result.missing.join(', ')} | | | |`,
      ),
    ];
    return lines.join('\n');
  };

  return (
    <div className="spike">
      <header className="spike-header">
        <h1>Spike A — browser voice loop</h1>
        <p className="panel-note">
          Microphone to VAD to speech recognition to speech synthesis, with the transcript
          echoed straight back. No language model. The number that matters is end of
          speech to first audio, against a {BUDGET_MS} ms budget.
        </p>
      </header>

      {phase === 'consent' ? (
        <section className="panel spike-consent">
          <div className="panel-header">
            <span className="panel-title">This will download models</span>
            <span className="pill pill-accent">{formatMb(totalBytes(models))} total</span>
          </div>
          <p className="panel-note">
            Nothing has been fetched yet. These are downloaded from Hugging Face on first
            use and cached by the browser afterwards.
          </p>
          <ul className="spike-models">
            {models.map((model) => (
              <li className="spike-model" key={model.repo + model.label}>
                <span className="spike-model-name">{model.label}</span>
                <span className="spike-model-meta">
                  {formatMb(model.bytes)} · {model.licence} ·{' '}
                  <a href={model.sourceUrl} rel="noreferrer" target="_blank">
                    {model.repo}
                  </a>
                </span>
              </li>
            ))}
          </ul>

          <div className="spike-controls">
            <label className="field">
              <span className="field-label">Backend</span>
              <select
                className="select"
                onChange={(event) => setBackend(event.target.value as Backend)}
                value={backend}
              >
                <option value="webgpu">WebGPU</option>
                <option value="wasm">WASM</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Precision</span>
              <select
                className="select"
                onChange={(event) => setDtype(event.target.value as SpikeDtype)}
                value={dtype}
              >
                <option value="q8">q8</option>
                <option value="fp16">fp16</option>
                <option value="fp32">fp32</option>
              </select>
            </label>
          </div>

          <div className="spike-controls">
            <button className="btn btn-primary" onClick={loadModels} type="button">
              Agree and download
            </button>
          </div>
        </section>
      ) : null}

      {phase !== 'consent' ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {backend} · {dtype}
            </span>
            <span className={`pill ${speaking ? 'pill-accent' : ''}`}>
              {speaking ? 'speech' : 'silence'}
            </span>
          </div>
          <p className="spike-status">{status}</p>
          <div className="spike-controls">
            <button
              className="btn btn-primary"
              disabled={phase !== 'ready'}
              onClick={() => void startMic()}
              type="button"
            >
              Start microphone
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                void capture.current?.stop();
                capture.current = null;
                setPhase('ready');
                setStatus('Microphone stopped.');
              }}
              type="button"
            >
              Stop
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                // Synthesis on its own, with text the recogniser never touched. If this
                // speaks and a real turn does not, the fault is upstream of TTS; if it
                // does not speak either, TTS is the fault and the transcript is a
                // separate problem.
                say('synthesis self-test: fixed sentence, no microphone involved');
                marks.current = EMPTY_MARKS;
                transcript.current = '(self-test)';
                tts.current?.postMessage({
                  type: 'speak',
                  text: 'The quick brown fox jumps over the lazy dog.',
                });
              }}
              type="button"
            >
              Test synthesis only
            </button>
            <button
              className="btn btn-ghost"
              disabled={!hasRecording}
              onClick={() => {
                const recording = lastRecording.current;
                if (recording !== null) playback.current.enqueue(recording, 16_000);
              }}
              type="button"
            >
              Play what the recogniser heard
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void navigator.clipboard.writeText(asMarkdown())}
              type="button"
            >
              Copy results as Markdown
            </button>
          </div>
        </section>
      ) : null}

      {turns.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              Median {summary.medianEndToFirstAudioMs ?? '—'} ms · worst{' '}
              {summary.worstEndToFirstAudioMs ?? '—'} ms
            </span>
            <span
              className={`pill ${
                summary.medianEndToFirstAudioMs !== null &&
                summary.medianEndToFirstAudioMs <= BUDGET_MS
                  ? 'pill-ok'
                  : 'pill-warn'
              }`}
            >
              budget {BUDGET_MS} ms
            </span>
          </div>
          <table className="spike-results">
            <thead>
              <tr>
                <th>#</th>
                <th>Transcript</th>
                <th>End→audio</th>
                <th>Hangover</th>
                <th>STT</th>
                <th>TTS</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((turn, index) => (
                <tr key={`${index}-${turn.text}`}>
                  <td>{index + 1}</td>
                  <td>{turn.text}</td>
                  {turn.result.complete ? (
                    <>
                      <td>{Math.round(turn.result.timing.endToFirstAudioMs)}</td>
                      <td>{Math.round(turn.result.timing.hangoverMs)}</td>
                      <td>{Math.round(turn.result.timing.sttMs)}</td>
                      <td>{Math.round(turn.result.timing.ttsMs)}</td>
                    </>
                  ) : (
                    <td colSpan={4}>
                      incomplete —{' '}
                      {turn.result.outOfOrder
                        ? 'marks out of order'
                        : `missing ${turn.result.missing.join(', ')}`}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {log.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Log</span>
            {heapMb === null ? null : <span className="pill">JS heap {heapMb} MB</span>}
          </div>
          <pre className="spike-log">{log.join('\n')}</pre>
        </section>
      ) : null}
    </div>
  );
}
