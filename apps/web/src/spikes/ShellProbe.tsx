import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  asMarkdownTable,
  probeCapabilities,
  probeMicrophone,
  reportToHost,
  type Capability,
  type CapabilityReport,
} from './capabilities';

/**
 * P0-T08 Spike E. The page that answers "does Linux ship as a Tauri app, or as
 * companion + Chrome".
 *
 * It is deliberately the thinnest thing that can hold a result: the spike's method is to
 * run *known-good* pages — /spike/voice, /spike/avatar, /spike/turn — in an unknown
 * container, so anything invented here is a variable rather than a measurement. All this
 * page does is ask the container what it has and print the answer somewhere copyable.
 */
export function ShellProbe(): ReactElement {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [microphone, setMicrophone] = useState<Capability | null>(null);

  useEffect(() => {
    let live = true;
    // The microphone runs unprompted here, unlike the button, because "mic" is one of the
    // six rows this spike has to fill in per OS and a row nobody clicked is a blank.
    void Promise.all([probeCapabilities(), probeMicrophone()]).then(([result, mic]) => {
      if (!live) return;
      setReport(result);
      setMicrophone(mic);
      void reportToHost(asMarkdownTable({ ...result, capabilities: [...result.capabilities, mic] }));
    });
    return () => {
      live = false;
    };
  }, []);

  const openMicrophone = useCallback(() => {
    void probeMicrophone().then(setMicrophone);
  }, []);

  if (!report) {
    return (
      <main className="spike">
        <p className="spike-status">Probing…</p>
      </main>
    );
  }

  const rows = microphone ? [...report.capabilities, microphone] : report.capabilities;
  const adapter = report.capabilities.find((capability) => capability.id === 'webgpu-adapter');

  return (
    <main className="spike">
      <header className="spike-header">
        <h1>Spike E — what this webview actually provides</h1>
        <p className="spike-status">
          {report.inTauri
            ? 'Running inside a Tauri webview. This is the measurement.'
            : 'Running in a browser, not in Tauri. This is a control, and must be labelled as one.'}
        </p>
        <p className="spike-status">{report.userAgent}</p>
      </header>

      {/* The one row the spike turns on, stated before the table so it cannot be missed:
          without a WebGPU adapter the voice pipeline is ~7x outside ADR-20's budget and
          no amount of shell engineering closes that. */}
      <p className={adapter?.present ? 'spike-verdict-yes' : 'spike-verdict-no'}>
        {adapter?.present
          ? 'WebGPU adapter present — the pipeline can run here.'
          : 'No WebGPU adapter — Spike A, B and D all depend on one.'}
      </p>

      <table className="spike-results">
        <thead>
          <tr>
            <th>Capability</th>
            <th>Present</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((capability) => (
            <tr key={capability.id}>
              <td>{capability.label}</td>
              <td className={capability.present ? 'spike-verdict-yes' : 'spike-verdict-no'}>
                {capability.present ? 'yes' : 'NO'}
              </td>
              <td>{capability.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="spike-controls">
        <button type="button" onClick={openMicrophone}>
          Open a microphone
        </button>
      </div>

      {/* Copyable, because retyping a spike result into the write-up is how a wrong
          number reaches a decision. */}
      <pre className="spike-log">
        {asMarkdownTable({ ...report, capabilities: rows })}
      </pre>
    </main>
  );
}
