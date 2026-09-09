import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { startCapture, type CaptureHandle } from './audio';
import { formatMb, totalBytes, turnModelsFor } from './consent';
import {
  EMPTY_CANDIDATE,
  type CandidateMarks,
  type CandidateResult,
  type LabelledTurn,
  type TurnLabel,
  confusion,
  spread,
  summariseDetection,
  timeCandidate,
} from './turn-metrics';

/**
 * Spike D: can Smart Turn v3 replace the 512 ms of silence Spike A spends waiting?
 *
 * Throwaway measurement code, like Spike A, and it reuses that spike's capture and VAD
 * rather than growing its own copy of both. The VAD runs with a short *candidate*
 * silence: every pause past it, the utterance so far goes to the model, and a probability
 * over the threshold ends the turn there. The 500 ms hangover stays as the backstop, so
 * every turn ends whether or not the model ever fires — and which of the two closed it is
 * the result.
 *
 * There is no synthesis here. The question is when a turn ends, not what is said back.
 */

type Build = 'cpu' | 'gpu';
type Backend = 'webgpu' | 'wasm';
type Phase = 'consent' | 'loading' | 'ready' | 'listening';

/** Spike A's measured hangover, and what this spike is trying to beat. */
const SPIKE_A_HANGOVER_MS = 512;

/** pipecat's own cut-off. Adjustable, because it is a product decision, not a constant. */
const DEFAULT_THRESHOLD = 0.5;

/**
 * How long a pause has to last before the model is asked. Short enough to be worth doing
 * — the whole point is answering sooner than 512 ms — and long enough that a breath
 * inside a word does not cost an inference.
 */
const DEFAULT_CANDIDATE_MS = 200;

interface TurnInFlight {
  readonly label: TurnLabel;
  readonly probabilities: number[];
  /** Marks per candidate, since a turn may ask the model several times. */
  readonly marks: Map<number, CandidateMarks>;
  /** The most recent candidate that produced a complete set of marks. */
  lastResult: CandidateResult | null;
  nextCandidate: number;
}

function ms(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value));
}

function percent(value: number | null): string {
  return value === null ? 'not measured' : `${(value * 100).toFixed(0)}%`;
}

function probability(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

export function TurnDetect(): ReactElement {
  const [phase, setPhase] = useState<Phase>('consent');
  // fp32 on WebGPU, from the bench in `docs/spikes/D-smart-turn.md`: 8 ms an inference
  // against 153 ms for int8 on wasm, with byte-identical probabilities to its own wasm
  // run. int8 on WebGPU does not load at all. The other three stay selectable, because a
  // default that hides the choice is how Spike A nearly reported the wrong backend.
  const [build, setBuild] = useState<Build>('gpu');
  const [backend, setBackend] = useState<Backend>('webgpu');
  const [candidateMs, setCandidateMs] = useState(DEFAULT_CANDIDATE_MS);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [label, setLabel] = useState<TurnLabel>('complete');
  const [status, setStatus] = useState('Waiting for consent.');
  const [log, setLog] = useState<readonly string[]>([]);
  const [turns, setTurns] = useState<readonly LabelledTurn[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [device, setDevice] = useState<CaptureHandle | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<string>('');

  const vad = useRef<Worker | null>(null);
  const smartTurn = useRef<Worker | null>(null);
  const capture = useRef<CaptureHandle | null>(null);
  const inFlight = useRef<Map<number, TurnInFlight>>(new Map());

  /**
   * The live threshold and label, for the worker handlers.
   *
   * The handlers are registered once at load; reading `threshold` from the closure would
   * pin them to whatever it was then, so moving the slider would change the display and
   * nothing else — and the write-up would quote a threshold that was never applied.
   */
  const thresholdRef = useRef(threshold);
  const labelRef = useRef(label);
  useEffect(() => {
    thresholdRef.current = threshold;
  }, [threshold]);
  useEffect(() => {
    labelRef.current = label;
  }, [label]);

  const say = useCallback((line: string) => {
    setLog((previous) => [...previous.slice(-60), line]);
  }, []);

  /** Close a turn, whichever of the two things ended it. */
  const finishTurn = useCallback((turnId: number, ending: LabelledTurn['ending']) => {
    const turn = inFlight.current.get(turnId);
    if (turn === undefined) return;
    inFlight.current.delete(turnId);
    setTurns((previous) => [
      ...previous,
      {
        label: turn.label,
        ending,
        probabilities: [...turn.probabilities],
        detection: turn.lastResult,
      },
    ]);
    setSpeaking(false);
  }, []);

  const loadModels = useCallback(() => {
    setPhase('loading');
    setStatus('Loading Silero and Smart Turn. First run downloads them.');

    vad.current = new Worker(new URL('./vad.worker.ts', import.meta.url), { type: 'module' });
    smartTurn.current = new Worker(new URL('./smart-turn.worker.ts', import.meta.url), {
      type: 'module',
    });

    for (const [name, worker] of [
      ['VAD', vad.current],
      ['Smart Turn', smartTurn.current],
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
    const oneReady = () => {
      ready += 1;
      if (ready === 2) {
        setPhase('ready');
        setStatus('Loaded. Pick a label, start the microphone, and say one utterance.');
      }
    };

    vad.current.addEventListener('message', (event: MessageEvent<Record<string, unknown>>) => {
      const message = event.data;
      const turnId = message['turnId'] as number;

      if (message['type'] === 'ready') {
        say(`VAD ready, state shape ${JSON.stringify(message['stateDims'])}`);
        oneReady();
      } else if (message['type'] === 'speech-start') {
        // The label is fixed when the utterance starts, not when it ends: changing it
        // afterwards would be marking your own homework.
        inFlight.current.set(turnId, {
          label: labelRef.current,
          probabilities: [],
          marks: new Map(),
          lastResult: null,
          nextCandidate: 0,
        });
        setSpeaking(true);
        setStatus(`Listening — ${labelRef.current} utterance in progress.`);
      } else if (message['type'] === 'candidate') {
        const turn = inFlight.current.get(turnId);
        if (turn === undefined) return;
        const index = turn.nextCandidate;
        turn.nextCandidate += 1;
        turn.marks.set(index, {
          ...EMPTY_CANDIDATE,
          // From the VAD, already on the page's clock via the capture worklet's offset.
          speechEnd: message['speechEndAt'] as number,
          candidateAt: message['at'] as number,
        });
        const samples = message['samples'] as Float32Array;
        smartTurn.current?.postMessage({ type: 'infer', samples, turnId, candidateIndex: index }, [
          samples.buffer,
        ]);
      } else if (message['type'] === 'settled') {
        // The model never crossed the threshold; the old timer had to do it.
        finishTurn(turnId, 'hangover');
        setStatus('Turn closed by the hangover. Next utterance when you are ready.');
      } else if (message['type'] === 'error') {
        say(`VAD error: ${String(message['message'])}`);
      }
    });

    smartTurn.current.addEventListener(
      'message',
      (event: MessageEvent<Record<string, unknown>>) => {
        const message = event.data;

        if (message['type'] === 'ready') {
          const loaded = message['loadMs'] as number;
          setLoadMs(Math.round(loaded));
          const requested = message['backend'] as string;
          const available = message['webgpuAvailable'] as boolean;
          setRuntime(
            `${String(message['build'])} / ${requested}` +
              (requested === 'webgpu' && !available ? ' — WebGPU NOT available in this worker' : ''),
          );
          say(
            `Smart Turn ready in ${Math.round(loaded)} ms; inputs ` +
              `${JSON.stringify(message['inputNames'])}, outputs ` +
              `${JSON.stringify(message['outputNames'])}, WebGPU available: ${String(available)}`,
          );
          oneReady();
          return;
        }

        if (message['type'] === 'error') {
          say(`Smart Turn error: ${String(message['message'])}`);
          return;
        }

        // A probability. The arrival is stamped here because the worker's clock is not
        // this one's — a dedicated worker has its own time origin.
        const inferenceDone = performance.now();
        const turnId = message['turnId'] as number;
        const index = message['candidateIndex'] as number;
        const value = message['probability'] as number;
        const inferenceMs = message['inferenceMs'] as number;

        if (message['featuresPlausible'] !== true) {
          // Not a Whisper log-mel. The model still returned a number and it still looks
          // like a probability; refusing it here is the only thing standing between that
          // and the write-up.
          say(
            `features rejected for turn ${turnId}: dims ` +
              `${JSON.stringify(message['featureDims'])} — probability discarded`,
          );
          setStatus('Feature check failed — see the log. Numbers from this run mean nothing.');
          return;
        }

        const turn = inFlight.current.get(turnId);
        if (turn === undefined) {
          say(`probability ${value.toFixed(3)} arrived for turn ${turnId}, already closed`);
          return;
        }

        const marks = turn.marks.get(index) ?? EMPTY_CANDIDATE;
        const completed: CandidateMarks = {
          ...marks,
          featuresDone: inferenceDone - inferenceMs,
          inferenceDone,
        };
        turn.marks.set(index, completed);
        turn.probabilities.push(value);
        turn.lastResult = timeCandidate(completed);

        const fired = value >= thresholdRef.current;
        say(
          `turn ${turnId} candidate ${index}: p=${value.toFixed(3)} ` +
            `(features ${Math.round(message['featuresMs'] as number)} ms, ` +
            `inference ${Math.round(inferenceMs)} ms)${fired ? ' — FIRE' : ''}`,
        );

        if (fired) {
          // Take the turn now, the way the product would: stop buffering so the next
          // word starts a new turn instead of joining the one just answered.
          vad.current?.postMessage({ type: 'end-turn', turnId });
          finishTurn(turnId, 'smart-turn');
          setStatus('Turn ended by Smart Turn. Next utterance when you are ready.');
        }
      },
    );

    vad.current.postMessage({ type: 'load', candidateMs });
    smartTurn.current.postMessage({ type: 'load', build, backend });
  }, [backend, build, candidateMs, finishTurn, say]);

  const startMic = useCallback(async () => {
    const handle = await startCapture((samples, at) => {
      vad.current?.postMessage({ type: 'frame', samples, at }, [samples.buffer]);
    });
    capture.current = handle;
    setDevice(handle);
    setPhase('listening');
    setStatus('Listening.');
    say(
      `Mic: ${handle.deviceLabel} at ${handle.deviceSampleRate ?? '?'} Hz, ` +
        `graph at ${handle.graphSampleRate} Hz`,
    );
  }, [say]);

  useEffect(() => {
    return () => {
      void capture.current?.stop();
      vad.current?.terminate();
      smartTurn.current?.terminate();
    };
  }, []);

  const matrix = confusion(turns);
  const detection = summariseDetection(turns);
  const probabilities = spread(turns);
  const models = turnModelsFor(build);
  /**
   * Beating the hangover means answering sooner than 512 ms, on utterances that were
   * actually finished. A model that is fast because it fires on everything is caught by
   * the false-fire rate beside it, not here.
   */
  const beatsHangover =
    detection.medianDetectionMs !== null && detection.medianDetectionMs < SPIKE_A_HANGOVER_MS;

  const asMarkdown = (): string => {
    const lines = [
      `### ${build} / ${backend} · candidate ${candidateMs} ms · threshold ${threshold}`,
      '',
      `- runtime: ${runtime || 'n/a'}`,
      `- device: ${device?.deviceLabel ?? 'n/a'} at ${device?.deviceSampleRate ?? '?'} Hz, ` +
        `graph ${device?.graphSampleRate ?? '?'} Hz`,
      `- model load: ${loadMs === null ? 'n/a' : `${loadMs} ms`}`,
      `- utterances: ${turns.length} (${matrix.truePositives + matrix.falseNegatives} complete, ` +
        `${matrix.falsePositives + matrix.trueNegatives} incomplete)`,
      '',
      `- **end of speech to an answer: median ${ms(detection.medianDetectionMs)} ms, ` +
        `worst ${ms(detection.worstDetectionMs)} ms** over the ${detection.turns} turns the ` +
        `model ended (${detection.incomplete} with broken marks)`,
      `- of which candidate silence ${ms(detection.medianSilenceMs)} ms, ` +
        `features ${ms(detection.medianFeaturesMs)} ms, ` +
        `inference ${ms(detection.medianInferenceMs)} ms (medians)`,
      `- model runs per turn, median: ${ms(detection.medianCandidatesPerTurn)}`,
      `- against Spike A's ${SPIKE_A_HANGOVER_MS} ms hangover: ` +
        `${beatsHangover ? 'faster' : 'not faster'}`,
      '',
      '| | fired | held off |',
      '|---|---|---|',
      `| complete | ${matrix.truePositives} | ${matrix.falseNegatives} |`,
      `| incomplete | ${matrix.falsePositives} | ${matrix.trueNegatives} |`,
      '',
      `- **false fire rate (interrupted a pause): ${percent(matrix.falseFireRate)}**`,
      `- miss rate (fell through to the timer): ${percent(matrix.missRate)}`,
      `- probabilities: ${probabilities.count} readings, ` +
        `${probability(probabilities.min)}–${probability(probabilities.max)}, ` +
        `mean ${probability(probabilities.mean)}, ` +
        `sd ${probability(probabilities.standardDeviation)}` +
        `${probabilities.outOfRange ? ' — SOME OUTSIDE [0, 1]' : ''}`,
      '',
      '| # | label | ended by | probabilities | end→answer | silence | features | inference |',
      '|---|---|---|---|---|---|---|---|',
      ...turns.map((turn, i) => {
        const cells =
          turn.detection?.complete === true
            ? [
                Math.round(turn.detection.timing.detectionMs),
                Math.round(turn.detection.timing.silenceMs),
                Math.round(turn.detection.timing.featuresMs),
                Math.round(turn.detection.timing.inferenceMs),
              ].join(' | ')
            : ' | | | ';
        return (
          `| ${i + 1} | ${turn.label} | ${turn.ending} | ` +
          `${turn.probabilities.map((p) => p.toFixed(3)).join(', ') || '—'} | ${cells} |`
        );
      }),
    ];
    return lines.join('\n');
  };

  return (
    <div className="spike">
      <header className="spike-header">
        <h1>Spike D — Smart Turn v3 in the browser</h1>
        <p className="panel-note">
          Spike A spends {SPIKE_A_HANGOVER_MS} ms of every turn waiting to be sure the
          person stopped talking — 54% of its latency. This asks a semantic endpointer
          instead, {DEFAULT_CANDIDATE_MS} ms into the pause. Label each utterance before
          you speak it: a model that fires on everything is fast and useless, and the
          false-fire rate is what catches that.
        </p>
      </header>

      {phase === 'consent' ? (
        <section className="panel spike-consent">
          <div className="panel-header">
            <span className="panel-title">This will download models</span>
            <span className="pill pill-accent">{formatMb(totalBytes(models))} total</span>
          </div>
          <p className="panel-note">
            Nothing has been fetched yet. Downloaded from Hugging Face on first use and
            cached by the browser afterwards.
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
              <span className="field-label">Build</span>
              <select
                className="select"
                onChange={(event) => setBuild(event.target.value as Build)}
                value={build}
              >
                <option value="gpu">gpu (fp32, 32.4 MB)</option>
                <option value="cpu">cpu (int8, 8.7 MB)</option>
              </select>
            </label>
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
              <span className="field-label">Candidate silence (ms)</span>
              <input
                className="input"
                max={500}
                min={40}
                onChange={(event) => setCandidateMs(Number(event.target.value))}
                step={20}
                type="number"
                value={candidateMs}
              />
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
            <span className="panel-title">{runtime || `${build} / ${backend}`}</span>
            <span className={`pill ${speaking ? 'pill-accent' : ''}`}>
              {speaking ? 'speech' : 'silence'}
            </span>
          </div>
          <p className="spike-status">{status}</p>

          <div className="spike-controls">
            <label className="field">
              <span className="field-label">Next utterance is</span>
              <select
                className="select"
                onChange={(event) => setLabel(event.target.value as TurnLabel)}
                value={label}
              >
                <option value="complete">complete — a finished sentence</option>
                <option value="incomplete">incomplete — trail off and wait</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Threshold</span>
              <input
                className="input"
                max={0.95}
                min={0.05}
                onChange={(event) => setThreshold(Number(event.target.value))}
                step={0.05}
                type="number"
                value={threshold}
              />
            </label>
          </div>

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
              Median {ms(detection.medianDetectionMs)} ms · worst{' '}
              {ms(detection.worstDetectionMs)} ms
            </span>
            <span className={`pill ${beatsHangover ? 'pill-ok' : 'pill-warn'}`}>
              vs {SPIKE_A_HANGOVER_MS} ms hangover
            </span>
          </div>
          <p className="panel-note">
            False fire {percent(matrix.falseFireRate)} of incomplete utterances · miss{' '}
            {percent(matrix.missRate)} of complete · silence{' '}
            {ms(detection.medianSilenceMs)} ms, features {ms(detection.medianFeaturesMs)} ms,
            inference {ms(detection.medianInferenceMs)} ms
          </p>
          <p className="panel-note">
            Probabilities: {probabilities.count} readings, {probability(probabilities.min)}–
            {probability(probabilities.max)}, sd {probability(probabilities.standardDeviation)}
            {probabilities.outOfRange ? ' — some outside [0, 1], the output is not a sigmoid' : ''}
          </p>
          <table className="spike-results">
            <thead>
              <tr>
                <th>#</th>
                <th>Label</th>
                <th>Ended by</th>
                <th>Probabilities</th>
                <th>End→answer</th>
                <th>Silence</th>
                <th>Features</th>
                <th>Inference</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((turn, index) => (
                <tr key={`${index}-${turn.label}`}>
                  <td>{index + 1}</td>
                  <td>{turn.label}</td>
                  <td>{turn.ending}</td>
                  <td>{turn.probabilities.map((p) => p.toFixed(3)).join(', ') || '—'}</td>
                  {turn.detection?.complete === true ? (
                    <>
                      <td>{Math.round(turn.detection.timing.detectionMs)}</td>
                      <td>{Math.round(turn.detection.timing.silenceMs)}</td>
                      <td>{Math.round(turn.detection.timing.featuresMs)}</td>
                      <td>{Math.round(turn.detection.timing.inferenceMs)}</td>
                    </>
                  ) : (
                    <td colSpan={4}>
                      {turn.detection === null
                        ? 'no candidate reached the model'
                        : 'marks incomplete'}
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
            {loadMs === null ? null : <span className="pill">load {loadMs} ms</span>}
          </div>
          <pre className="spike-log">{log.join('\n')}</pre>
        </section>
      ) : null}
    </div>
  );
}
