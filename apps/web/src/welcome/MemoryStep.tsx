import { useState } from 'react';
import type { ReactElement } from 'react';
import type { HttpFetch } from '@latentpresence/providers/web';
import type { ConnectionResult } from '../settings/connection';
import { ConnectionStatus } from '../settings/ConnectionStatus';
import type { MemorySetting } from '../settings/settings';
import { checkCompanionDatabase, describeMemoryCheck } from './memory-check';

export interface MemoryStepProps {
  readonly memory: MemorySetting;
  readonly onChange: (next: MemorySetting) => void;
  readonly companionUrl: string;
  readonly fetch: HttpFetch;
  /** The desktop app: the companion is the app's own, and a restart is how it learns a new variable. */
  readonly inApp: boolean;
  /** A page served from the internet (not from this computer): it has no companion of its own. */
  readonly hosted: boolean;
}

interface Choice {
  readonly value: MemorySetting;
  readonly title: string;
  readonly tag: string | null;
  readonly text: string;
}

function choices(inApp: boolean): readonly Choice[] {
  const where = inApp ? 'this app' : 'this browser';
  return [
    {
      value: 'browser',
      title: 'On this computer',
      tag: 'Recommended',
      text: `Kept on this computer, inside ${where}. Nothing to set up. Another browser or another computer starts from nothing.`,
    },
    {
      value: 'companion',
      title: 'A MariaDB server',
      tag: 'Advanced',
      text: 'For people who already run MariaDB 11.8 or newer. Shared by every browser and device that uses it.',
    },
    { value: 'off', title: "Don't remember", tag: null, text: 'She remembers nothing between visits, and within a visit only the conversation itself.' },
  ];
}

/**
 * Step 4 (P8-T02): where she remembers. The three plain choices; "Automatic" stays in Settings.
 * Choosing MariaDB shows the exact steps for where this page is running and a Check button, but a
 * passing check is not required: they may set the database up later, and the page says what happens until then.
 */
export function MemoryStep({ memory, onChange, companionUrl, fetch, inApp, hosted }: MemoryStepProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ConnectionResult | null>(null);

  async function check(): Promise<void> {
    setPending(true);
    setResult(null);
    const outcome = await checkCompanionDatabase({ companionUrl, fetch });
    setResult(describeMemoryCheck(outcome, inApp, companionUrl));
    setPending(false);
  }

  return (
    <>
      <p className="welcome-lead">Where should she keep what she learns about you?</p>
      <fieldset className="welcome-choices">
        <legend className="field-label">Remember in</legend>
        {choices(inApp).map((choice) => {
          const selected = memory === choice.value;
          return (
            <label className={`welcome-choice ${selected ? 'welcome-choice-selected' : ''}`} key={choice.value}>
              <input checked={selected} name="welcome-memory" onChange={() => { onChange(choice.value); setResult(null); }} type="radio" value={choice.value} />
              <span className="welcome-choice-body">
                <span className="welcome-choice-title">
                  {choice.title}
                  {choice.tag !== null && <span className="pill pill-accent">{choice.tag}</span>}
                </span>
                <span className="field-hint">{choice.text}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {memory === 'auto' && (
        <p className="field-hint">Memory is set to Automatic in Settings. Choosing one of these replaces that.</p>
      )}

      {memory === 'companion' && (
        <div className="welcome-detail">
          <h2 className="welcome-subheading">Connect your MariaDB server</h2>
          <p className="field-hint">It must be MariaDB 11.8 or newer. The companion reads the database address from a setting called DATABASE_URL.</p>
          {hosted && !inApp ? (
            <p className="field-hint">
              This page is hosted on the internet, so it has no companion of its own, and MariaDB is not available here. Choose
              On this computer, or use the desktop app, or run latentPresence from its folder on your computer.
            </p>
          ) : inApp ? (
            <ol className="settings-help-steps">
              <li>Press Start and search for &ldquo;environment variables&rdquo;.</li>
              <li>Choose &ldquo;Edit environment variables for your account&rdquo;.</li>
              <li>
                Under User variables choose New, then type the name <code>DATABASE_URL</code> and the value, for example{' '}
                <code>mysql://user:password@host:3306/latentpresence</code>
              </li>
              <li>Press OK, then quit this app and open it again. The companion starts with the app and reads the variable then.</li>
              <li>Come back to this step and press Check.</li>
            </ol>
          ) : (
            <ol className="settings-help-steps">
              <li>
                In the latentPresence folder, open the file named <code>.env</code> and add the line{' '}
                <code>DATABASE_URL=mysql://user:password@host:3306/latentpresence</code>
              </li>
              <li>
                Open a terminal in that folder and start the companion with <code>pnpm companion</code> and leave it running.
              </li>
              <li>Press Check.</li>
            </ol>
          )}
          <div className="settings-test-row">
            <button className="btn btn-sm" disabled={pending} onClick={() => void check()} type="button">
              Check
            </button>
            <ConnectionStatus pending={pending} result={result} />
          </div>
          <p className="field-hint">You do not have to pass the check now. Nothing is remembered while the companion has no database.</p>
        </div>
      )}
    </>
  );
}
