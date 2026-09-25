import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { readingWeight, recordFusion, type AttachedAffect, type AttachedUserAffect } from '@latentpresence/core';

/**
 * The affect debug overlay on `/chat` (P3-T07), shown with `/chat?affect`: every channel's
 * latest reading and the weight it carries now, the fused estimate, what was last told to
 * the model, and how she feels. **Copy recording** puts every fusion input since the page
 * opened on the clipboard, as JSON that `replayFusion` reproduces exactly.
 *
 * Read-only: it polls four times a second and changes nothing it shows.
 */

export interface AffectOverlayProps {
  readonly userAffect: AttachedUserAffect;
  readonly affect: AttachedAffect;
}

const REFRESH_MS = 250;

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

export function AffectOverlay({ userAffect, affect }: AffectOverlayProps): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const recorder = useRef<ReturnType<typeof recordFusion> | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Started in the effect, not in a state initializer: StrictMode runs a mount-time cleanup
  // in development, and a recorder stopped there and never restarted recorded nothing — the
  // first live check copied an empty session.
  useEffect(() => {
    const started = recordFusion(userAffect.fusion);
    recorder.current = started;
    return () => started.stop();
  }, [userAffect.fusion]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const { fusion } = userAffect;
  const fused = fusion.current(now);
  const told = fusion.last();
  const state = affect.state();
  const feeling = affect.feeling();

  const copy = (): void => {
    const recording = recorder.current?.recording() ?? { version: 1 as const, inputs: [] };
    navigator.clipboard.writeText(JSON.stringify(recording)).then(
      () => setCopied(`Copied ${recording.inputs.length} inputs.`),
      (error: unknown) => setCopied(error instanceof Error ? error.message : String(error)),
    );
  };

  return (
    <aside className="affect-overlay" data-testid="affect-overlay">
      <div className="affect-overlay-title">How they seem</div>
      <table className="affect-overlay-table">
        <tbody>
          {fusion.sources().map((entry) => (
            <tr key={entry.source}>
              <td>{entry.source}</td>
              <td>{entry.reading.label}</td>
              <td>{entry.reading.confidence.toFixed(2)}</td>
              <td>w {readingWeight(entry, now, false).toFixed(2)}</td>
              <td>{Math.round((now - entry.at) / 1000)} s</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="affect-overlay-line" data-testid="affect-fused">
        {fused === null
          ? 'fused: nothing to go on'
          : `fused: ${fused.label} ${fused.confidence.toFixed(2)} · v ${signed(fused.valence)} a ${signed(fused.arousal)}`}
      </p>
      <p className="affect-overlay-line">{told === null ? 'told her: nothing yet' : `told her: ${told.label} ${told.confidence.toFixed(2)}`}</p>
      <div className="affect-overlay-title">How she feels</div>
      <p className="affect-overlay-line">
        P {signed(state.mood.pleasure)} A {signed(state.mood.arousal)} D {signed(state.mood.dominance)} · energy {state.energy.toFixed(2)}
      </p>
      <p className="affect-overlay-line">
        {feeling.label === 'neutral' ? 'no feeling in particular' : `${feeling.label} ${feeling.intensity.toFixed(2)}`}
      </p>
      <button className="btn btn-ghost affect-overlay-copy" onClick={copy} type="button">
        Copy recording
      </button>
      {copied !== null && <p className="affect-overlay-line">{copied}</p>}
    </aside>
  );
}
