import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { HttpFetch } from '@latentpresence/providers/web';
import type { DatabaseInfo, DesktopDatabase } from '../desktop/database';
import type { ConnectionResult } from './connection';
import { ConnectionStatus } from './ConnectionStatus';
import { checkCompanionDatabase, describeMemoryCheck, type MemoryCheck } from './memory-check';

export interface CompanionDatabaseProps {
  /** The shell's database commands; this control exists only in the desktop app. */
  readonly database: DesktopDatabase;
  readonly companionUrl: string;
  readonly fetch: HttpFetch;
  /** How long to wait for the restarted companion to answer before saying it did not. */
  readonly waitMs?: number;
  /** Between two asks while waiting. */
  readonly pollMs?: number;
}

const PLACEHOLDER = 'mysql://user:password@host:3306/latentpresence';

/**
 * The database address, in the desktop app (ADR-62): typed here, kept in Windows Credential
 * Manager by the shell, handed to the companion, which restarts on it. Like a key it never shows
 * again once saved — only where it points, without the password. After a save or a forget it asks
 * the companion's `/health` until the restarted companion answers (connecting to a database can
 * take a few seconds before it serves anything), then says what it found and what to do next.
 */
export function CompanionDatabase({ database, companionUrl, fetch, waitMs = 30_000, pollMs = 1000 }: CompanionDatabaseProps): ReactElement {
  const [info, setInfo] = useState<DatabaseInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'saving' | 'checking' | null>(null);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    database.info().then(
      (found) => {
        if (!mounted.current) return;
        setInfo(found);
        setEditing(!found.saved);
      },
      () => {
        if (!mounted.current) return;
        setInfo({ saved: false, address: null });
        setEditing(true);
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [database]);

  /** Asks once (Check), or after a restart until the companion answers or `waitMs` has gone by. */
  async function settle(afterRestart: boolean): Promise<void> {
    setBusy('checking');
    const deadline = Date.now() + (afterRestart ? waitMs : 0);
    let outcome: MemoryCheck = await checkCompanionDatabase({ companionUrl, fetch });
    while (outcome === 'not-running' && Date.now() < deadline && mounted.current) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      outcome = await checkCompanionDatabase({ companionUrl, fetch });
    }
    if (!mounted.current) return;
    setResult(describeMemoryCheck(outcome, true, companionUrl));
    setBusy(null);
  }

  async function change(action: () => Promise<DatabaseInfo>): Promise<void> {
    setBusy('saving');
    setResult(null);
    let next: DatabaseInfo;
    try {
      next = await action();
    } catch (error) {
      if (!mounted.current) return;
      setResult({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
      setBusy(null);
      return;
    }
    if (!mounted.current) return;
    setInfo(next);
    setEditing(!next.saved);
    setValue('');
    await settle(true);
  }

  function save(): void {
    if (value.trim() === '' || busy !== null) return;
    void change(() => database.save(value));
  }

  const pending = busy !== null;
  const status: ConnectionResult | null = busy === 'saving' ? { tone: 'warn', text: 'Restarting the companion with it…' } : result;

  return (
    <div className="field">
      <label className="field-label" htmlFor="companion-database-address">
        Database address
      </label>
      {info === null ? (
        <span className="field-hint">Looking…</span>
      ) : info.saved && !editing ? (
        <div className="settings-key-row">
          <span className="pill pill-ok">Saved</span>
          <code className="companion-database-address">{info.address}</code>
          <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => setEditing(true)} type="button">
            Replace
          </button>
          <button className="btn btn-sm btn-danger" disabled={pending} onClick={() => void change(() => database.forget())} type="button">
            Forget
          </button>
        </div>
      ) : (
        <div className="settings-key-row">
          <input
            autoComplete="off"
            className="input"
            id="companion-database-address"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            type="password"
            value={value}
          />
          <button className="btn btn-sm" disabled={value.trim() === '' || pending} onClick={save} type="button">
            Save
          </button>
        </div>
      )}
      <span className="field-hint">
        The address of your MariaDB 11.8 (or newer) database, like <code>{PLACEHOLDER}</code>. It is kept in Windows
        Credential Manager, and the password is never shown again.
      </span>
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={pending} onClick={() => void settle(false)} type="button">
          Check
        </button>
        <ConnectionStatus pending={busy === 'checking'} result={status} />
      </div>
    </div>
  );
}
