import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { desktopUpdates, type UpdateInfo, type UpdateProgress, type UpdatesApi } from '../desktop/updates';

/**
 * Settings → This app, in the desktop app only: what the close button does (P8-T05, ADR-65), and
 * updates (P8-T04, ADR-66) — the version, Check for updates, Install, and whether to check at start.
 */
export interface DesktopAppSectionProps {
  readonly closeToTray: boolean;
  readonly onChange: (closeToTray: boolean) => void;
  readonly checkUpdates: boolean;
  readonly onCheckUpdatesChange: (checkUpdates: boolean) => void;
  /** Test seam: the shell's updates. */
  readonly updates?: UpdatesApi | null;
}

type UpdateState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'newest' }
  | { readonly phase: 'available'; readonly info: UpdateInfo }
  | { readonly phase: 'installing'; readonly info: UpdateInfo; readonly progress: UpdateProgress | null }
  | { readonly phase: 'failed'; readonly sentence: string };

function sentenceOf(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : String(error);
}

function percent(progress: UpdateProgress | null): string {
  if (progress === null) return 'Starting the download…';
  if (progress.total === null || progress.total === 0) return `Downloading… ${Math.round(progress.downloaded / 1_048_576)} MB`;
  return `Downloading… ${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`;
}

function Updates({ api, checkUpdates, onCheckUpdatesChange }: { readonly api: UpdatesApi; readonly checkUpdates: boolean; readonly onCheckUpdatesChange: (on: boolean) => void }): ReactElement {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });

  useEffect(() => {
    let live = true;
    api.version().then(
      (found) => {
        if (live) setVersion(found);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  async function check(): Promise<void> {
    setState({ phase: 'checking' });
    try {
      const found = await api.check();
      setState(found === null ? { phase: 'newest' } : { phase: 'available', info: found });
    } catch (error) {
      setState({ phase: 'failed', sentence: sentenceOf(error) });
    }
  }

  async function install(info: UpdateInfo): Promise<void> {
    setState({ phase: 'installing', info, progress: null });
    const stop = api.onProgress((progress) => setState({ phase: 'installing', info, progress }));
    try {
      await api.install();
    } catch (error) {
      setState({ phase: 'failed', sentence: sentenceOf(error) });
    } finally {
      stop();
    }
  }

  const busy = state.phase === 'checking' || state.phase === 'installing';
  return (
    <div className="field">
      <span className="field-label">Updates</span>
      <p className="field-hint">{version === null ? 'This version' : `This is version ${version}.`}</p>
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={busy} onClick={() => void check()} type="button">
          Check for updates
        </button>
        <div aria-live="polite" className="settings-status-region">
          {state.phase === 'checking' && <p className="settings-status settings-status-warn">Checking…</p>}
          {state.phase === 'newest' && <p className="settings-status settings-status-ok">You have the newest version.</p>}
          {state.phase === 'available' && <p className="settings-status settings-status-ok">Version {state.info.version} is ready.</p>}
          {state.phase === 'installing' && <p className="settings-status settings-status-warn">{percent(state.progress)}</p>}
          {state.phase === 'failed' && <p className="settings-status settings-status-danger">{state.sentence}</p>}
        </div>
      </div>
      {state.phase === 'available' && (
        <div className="update-offer">
          {state.info.notes !== null && state.info.notes.trim() !== '' && <p className="update-notes">{state.info.notes}</p>}
          <button className="btn btn-primary btn-sm" onClick={() => void install(state.info)} type="button">
            Install and restart
          </button>
          <span className="field-hint">The app closes, the installer runs, and the new version opens. Your conversations and settings stay.</span>
        </div>
      )}
      <label className="tools-switch">
        <input checked={checkUpdates} onChange={(event) => onCheckUpdatesChange(event.target.checked)} type="checkbox" />
        <span>Check for updates when the app starts</span>
      </label>
      <span className="field-hint">The check asks GitHub, where the releases are, and nothing else is sent. Off unless you turn it on.</span>
    </div>
  );
}

export function DesktopAppSection({ closeToTray, onChange, checkUpdates, onCheckUpdatesChange, updates }: DesktopAppSectionProps): ReactElement {
  const [api] = useState<UpdatesApi | null>(() => (updates === undefined ? desktopUpdates() : updates));
  return (
    <section aria-label="This app" className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">This app</span>
      </div>
      <label className="tools-switch">
        <input checked={closeToTray} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
        <span>Closing the window keeps her running in the tray</span>
      </label>
      <p className="field-hint">
        Her reminders and schedules carry on, and a call, the camera and face reading end. Open her again, or quit, from the tray icon by the
        clock. Turned off, closing the window quits.
      </p>
      {api !== null && <Updates api={api} checkUpdates={checkUpdates} onCheckUpdatesChange={onCheckUpdatesChange} />}
    </section>
  );
}
