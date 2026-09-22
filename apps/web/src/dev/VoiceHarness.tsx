import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConversationEvent } from '@latentpresence/protocol';
import { ConsentScreen } from '../consent/ConsentScreen';
import { defaultModelConsent } from '../consent/deps';
import { TranscriptPanel } from '../transcript/TranscriptPanel';
import { useTranscript } from '../transcript/useTranscript';
import type { OutputReport } from './output-check';
import { VoicePipeline, downloads, type InputChoice, type Snapshot, type VoiceCheckRow } from './voice-pipeline';
import { defaultPersona } from '../persona/default-persona';

/**
 * `/dev/voice` (P1-T08): the promoted voice pipeline in a browser, replacing Spike A's page.
 * The logic lives in `voice-pipeline.ts`; this is a view over it. P1-T11 adds the
 * transcript panel beside the measurement tables, reading `VoicePipeline.onConversation`.
 *
 * **P1-T13 replaced this page's own ad-hoc "Agree and start" screen with `ConsentScreen`**,
 * the one every browser-model caller now shares, rather than leaving two.
 */

/** From the persona file since P1-T12 — the same name `/chat` uses. With the scripted
 * model only the name is used; with **Live model** (P1-T12b) the persona's prompt is sent
 * too, which is what makes history visible here at all. */
const CHARACTER_NAME = defaultPersona.name;

function ms(value: number | null): string {
  return value === null ? '—' : String(Math.round(value));
}

function asMarkdown(snapshot: Snapshot | null, output: OutputReport | null, voice: readonly VoiceCheckRow[]): string {
  const lines = ['| # | user | end | judge ms | speech end → audio ms | 1st sentence synth ms | status | heard |', '|---|---|---|---|---|---|---|---|'];
  for (const row of snapshot?.rows ?? []) {
    lines.push(
      `| ${row.id} | ${row.user ?? ''} | ${row.reason ?? ''} ${row.probability?.toFixed(2) ?? ''} | ${ms(row.judgeMs)} | ${ms(row.speechEndToAudioMs)} | ${ms(row.firstSentenceSynthMs)} | ${row.status} | ${row.heard ?? ''} |`,
    );
  }
  if (output !== null) {
    lines.push('', `output: ${output.frames} frames, peak ${output.peak.toFixed(3)}, clamped ${output.clamped}, speech step p99.9 ${output.speechStep.toFixed(4)}, clicks ${output.clicks} of ${output.marks.length} events`);
    for (const mark of output.marks) lines.push(`- ${mark.kind} @${Math.round(mark.frame)}: step ${mark.maxStep.toFixed(4)} (×${mark.ratio.toFixed(2)})${mark.click ? ' CLICK' : ''}`);
  }
  if (voice.length > 0) {
    lines.push('', '| sentence | browser ms | node fp32 ms | synth ms | peak | word errors | transcript |', '|---|---|---|---|---|---|---|');
    for (const row of voice) lines.push(`| ${row.text} | ${ms(row.durationMs)} | ${row.nodeMs} | ${ms(row.synthMs)} | ${row.peak.toFixed(3)} | ${row.wordErrors}/${row.words} | ${row.transcript} |`);
  }
  lines.push('', '```', ...(snapshot?.log ?? []), '```');
  return lines.join('\n');
}

export function VoiceHarness(): ReactElement {
  const [bargeInMs, setBargeInMs] = useState(200);
  const [overlap, setOverlap] = useState<'duck' | 'cut'>('duck');
  const [live, setLive] = useState(false);
  const [phase, setPhase] = useState<'consent' | 'loading' | 'ready'>('consent');
  const [status, setStatus] = useState('Nothing downloaded yet.');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [output, setOutput] = useState<OutputReport | null>(null);
  const [voiceRows, setVoiceRows] = useState<readonly VoiceCheckRow[]>([]);
  const [autoInterrupt, setAutoInterrupt] = useState('off');
  const pipeline = useRef<VoicePipeline | null>(null);
  // Mirrors `pipeline.current` in state: the transcript's `subscribe` must change identity
  // once the pipeline exists, so `useTranscript`'s effect re-subscribes to it — a ref alone
  // never triggers that.
  const [built, setBuilt] = useState<VoicePipeline | null>(null);

  useEffect(
    () => () => {
      void pipeline.current?.stop();
    },
    [],
  );

  const subscribeConversation = useCallback(
    (listener: (event: ConversationEvent) => void) => built?.onConversation(listener) ?? ((): void => {}),
    [built],
  );
  const { lines: transcriptLines, clear: clearTranscript } = useTranscript(subscribeConversation);

  const models = downloads();
  const speaking = snapshot?.state === 'speaking';
  // One consent object for the page's life, over this browser's real `localStorage` — a
  // `useMemo` rather than a top-level instance, so nothing touches `window` before render
  // (`apps/web/src/consent/deps.ts`).
  const consent = useMemo(() => defaultModelConsent(), []);

  async function start(): Promise<void> {
    if (phase === 'loading') return;
    consent.grant(models);
    setPhase('loading');
    try {
      const startedPipeline = await VoicePipeline.start({ consent, bargeInMs, overlap, live, log: setStatus });
      pipeline.current = startedPipeline;
      setBuilt(startedPipeline);
      // For poking at from the console; dev-only, like the page.
      Object.assign(globalThis, { voiceHarness: startedPipeline });
      startedPipeline.subscribe(setSnapshot);
      setPhase('ready');
      setStatus('Ready. Choose an input.');
    } catch (error) {
      setStatus(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
      setPhase('consent');
    }
  }

  async function listen(input: InputChoice): Promise<void> {
    try {
      await pipeline.current?.listen(input);
      setStatus(`Listening (${input}).`);
    } catch (error) {
      setStatus(`Could not listen: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div className="spike">
      <header className="spike-header">
        <h1>Voice harness</h1>
        <p className="panel-note">
          P1-T08 and P1-T09. Silero, Smart Turn, Moonshine and Kokoro through the real queue, barge-in and backchannels, with a scripted
          model. The simulated speaker needs no microphone.
        </p>
      </header>

      {phase !== 'ready' ? (
        <>
          <section className="panel spike-consent">
            <div className="panel-header">
              <span className="panel-title">Harness options</span>
            </div>
            <div className="spike-controls">
              <label className="field">
                <span className="field-label">Barge-in after</span>
                <select className="select" onChange={(event) => setBargeInMs(Number(event.target.value))} value={bargeInMs}>
                  <option value={0}>0 ms (first speech frame)</option>
                  <option value={200}>200 ms</option>
                  <option value={300}>300 ms</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Backchannel talked over</span>
                <select className="select" onChange={(event) => setOverlap(event.target.value === 'cut' ? 'cut' : 'duck')} value={overlap}>
                  <option value="duck">duck and finish (ADR-28)</option>
                  <option value="cut">cut</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Model</span>
                <select className="select" onChange={(event) => setLive(event.target.value === 'live')} value={live ? 'live' : 'scripted'}>
                  <option value="scripted">scripted answer (same every turn)</option>
                  <option value="live">live model from /settings</option>
                </select>
              </label>
            </div>
            <p className="spike-status">{status}</p>
          </section>
          <ConsentScreen
            descriptors={models}
            onAgree={() => void start()}
            onCancel={() => setStatus('Cancelled. Nothing was downloaded.')}
          />
        </>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {snapshot?.input ?? 'no input'} · output latency {snapshot?.outputLatencyMs ?? '—'} ms · frame lag{' '}
              {snapshot?.lagMs.capture ?? '—'}/{snapshot?.lagMs.vad ?? '—'} ms
            </span>
            <span className={`pill ${speaking ? 'pill-accent' : ''}`}>{snapshot?.state ?? 'idle'}</span>
          </div>
          <p className="spike-status">{status}</p>
          <div className="spike-controls">
            <button className="btn btn-primary" onClick={() => void listen('simulated')} type="button">
              Simulated speaker
            </button>
            <button className="btn btn-ghost" onClick={() => void listen('microphone')} type="button">
              Microphone
            </button>
            <button className="btn btn-ghost" onClick={() => pipeline.current?.ask()} type="button">
              Ask
            </button>
            <button className="btn btn-ghost" onClick={() => pipeline.current?.tell()} type="button">
              Tell a story
            </button>
            <button className="btn btn-ghost" onClick={() => pipeline.current?.interrupt()} type="button">
              Interrupt
            </button>
            <label className="field">
              <span className="field-label">Auto-interrupt</span>
              <select
                className="select"
                onChange={(event) => {
                  setAutoInterrupt(event.target.value);
                  pipeline.current?.setAutoInterrupt(event.target.value === 'off' ? null : Number(event.target.value));
                }}
                value={autoInterrupt}
              >
                <option value="off">off</option>
                <option value="1500">1.5 s into the answer</option>
                <option value="4000">4 s into the answer</option>
              </select>
            </label>
          </div>
          <div className="spike-controls">
            <button className="btn btn-ghost" onClick={() => setOutput(pipeline.current?.outputReport() ?? null)} type="button">
              Check output for clicks
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setStatus('Checking the voice…');
                void pipeline.current?.voiceCheck().then((rows) => {
                  setVoiceRows(rows);
                  setStatus('Voice check done.');
                });
              }}
              type="button"
            >
              Voice check
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void navigator.clipboard.writeText(asMarkdown(snapshot, output, voiceRows))}
              type="button"
            >
              Copy results as Markdown
            </button>
          </div>
        </section>
      )}

      {phase === 'ready' && (
        <TranscriptPanel characterName={CHARACTER_NAME} lines={transcriptLines} onClear={clearTranscript} />
      )}

      {snapshot !== null && snapshot.rows.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Turns</span>
          </div>
          <table className="spike-results">
            <thead>
              <tr>
                <th>#</th>
                <th>User</th>
                <th>End</th>
                <th>Judge</th>
                <th>Speech end → audio</th>
                <th>1st sentence</th>
                <th>Status</th>
                <th>Heard</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.user ?? ''}</td>
                  <td>
                    {row.reason ?? ''} {row.probability?.toFixed(2) ?? ''}
                  </td>
                  <td>{ms(row.judgeMs)}</td>
                  <td>{ms(row.speechEndToAudioMs)}</td>
                  <td>{ms(row.firstSentenceSynthMs)}</td>
                  <td>{row.status}</td>
                  <td>{row.heard ?? (row.status === 'complete' ? '(all of it)' : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {output !== null ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              Output: {output.clicks} clicks in {output.marks.length} events
            </span>
            <span className={`pill ${output.clicks === 0 ? 'pill-ok' : 'pill-warn'}`}>
              peak {output.peak.toFixed(3)} · clamped {output.clamped}
            </span>
          </div>
          <table className="spike-results">
            <thead>
              <tr>
                <th>Event</th>
                <th>Frame</th>
                <th>Largest step</th>
                <th>× speech p99.9</th>
              </tr>
            </thead>
            <tbody>
              {output.marks.map((mark, index) => (
                <tr key={`${mark.kind}-${index}`}>
                  <td>{mark.kind}</td>
                  <td>{Math.round(mark.frame)}</td>
                  <td>{mark.maxStep.toFixed(4)}</td>
                  <td>{mark.ratio.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {voiceRows.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Kokoro fp32 on WebGPU against node</span>
          </div>
          <table className="spike-results">
            <thead>
              <tr>
                <th>Sentence</th>
                <th>Browser ms</th>
                <th>Node ms</th>
                <th>Synth ms</th>
                <th>Peak</th>
                <th>Word errors</th>
                <th>Moonshine heard</th>
              </tr>
            </thead>
            <tbody>
              {voiceRows.map((row) => (
                <tr key={row.text}>
                  <td>{row.text}</td>
                  <td>{ms(row.durationMs)}</td>
                  <td>{row.nodeMs}</td>
                  <td>{ms(row.synthMs)}</td>
                  <td>{row.peak.toFixed(3)}</td>
                  <td>
                    {row.wordErrors}/{row.words}
                  </td>
                  <td>{row.transcript}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {snapshot !== null && snapshot.log.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Log</span>
          </div>
          <pre className="spike-log">{snapshot.log.join('\n')}</pre>
        </section>
      ) : null}
    </div>
  );
}
