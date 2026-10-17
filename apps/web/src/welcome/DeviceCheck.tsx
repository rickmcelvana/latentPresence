import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConnectionResult } from '../settings/connection';
import { ConnectionStatus } from '../settings/ConnectionStatus';
import { describeMediaError, stopStream, type DeviceKind, type WizardDevices } from './devices';

export interface DeviceCheckProps {
  readonly kind: DeviceKind;
  readonly devices: WizardDevices;
  /** The desktop app, where a refusal is Windows' to undo. */
  readonly inApp: boolean;
}

type Phase = 'idle' | 'starting' | 'on' | 'done';

interface Session {
  readonly stream: MediaStream;
  readonly stopMeter: (() => void) | null;
  readonly timer: number | null;
}

/** Ends a check: the timer, the meter and, last, the device itself. */
function stopSession(session: Session): void {
  if (session.timer !== null) window.clearTimeout(session.timer);
  session.stopMeter?.();
  stopStream(session.stream);
}

/**
 * One "Test microphone" or "Test camera" (P8-T02). The device is opened by the click and by
 * nothing else, shown for a few seconds (a level bar, or a small picture), and then every track
 * is stopped. A failure says what to do next on screen, for the app or for a browser.
 *
 * The stream and the meter live in refs, not state, so that leaving the step (an unmount) stops
 * them even mid-test: a camera light left on by a wizard would be the worst way to meet it.
 */
export function DeviceCheck({ kind, devices, inApp }: DeviceCheckProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const live = useRef<Session | null>(null);
  const mounted = useRef(true);

  function stopLive(): void {
    const current = live.current;
    live.current = null;
    if (current !== null) stopSession(current);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = live.current;
      live.current = null;
      if (current !== null) stopSession(current);
    };
  }, []);

  const noun = kind === 'microphone' ? 'Microphone' : 'Camera';

  async function start(): Promise<void> {
    stopLive();
    setResult(null);
    setLevel(0);
    setPhase('starting');
    let stream: MediaStream;
    try {
      stream = await devices.getUserMedia(kind === 'microphone' ? { audio: true } : { video: true });
    } catch (error) {
      if (!mounted.current) return;
      setResult(describeMediaError(kind, error, inApp));
      setPhase('idle');
      return;
    }
    if (!mounted.current) {
      stopStream(stream);
      return;
    }
    let stopMeter: (() => void) | null = null;
    try {
      stopMeter = kind === 'microphone' ? devices.startLevelMeter(stream, setLevel) : null;
    } catch {
      // A meter that will not start is not a microphone that does not work: the stream opened.
      stopMeter = null;
    }
    const timer = window.setTimeout(finish, devices.durationMs);
    live.current = { stream, stopMeter, timer };
    if (kind === 'camera') setPreview(stream);
    setPhase('on');
  }

  function finish(): void {
    stopLive();
    if (!mounted.current) return;
    setPreview(null);
    setLevel(0);
    setResult({ tone: 'ok', text: `${noun} works.` });
    setPhase('done');
  }

  return (
    <div className="welcome-device">
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={phase === 'starting' || phase === 'on'} onClick={() => void start()} type="button">
          Test {kind}
        </button>
        <ConnectionStatus pending={phase === 'starting'} result={result} />
      </div>
      {phase === 'on' && kind === 'microphone' && (
        <>
          <p className="settings-status settings-status-ok">{noun} works. Say something and the bar should move.</p>
          <div aria-hidden="true" className="welcome-meter">
            <div className="welcome-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        </>
      )}
      {phase === 'on' && kind === 'camera' && (
        <>
          <p className="settings-status settings-status-ok">{noun} works. This picture stays on this computer and stops in a moment.</p>
          <video
            aria-label="Camera preview"
            autoPlay
            className="welcome-preview"
            muted
            playsInline
            ref={(element) => {
              if (element !== null && element.srcObject !== preview) element.srcObject = preview;
            }}
          />
        </>
      )}
    </div>
  );
}
