import type { ReactElement } from 'react';
import type { ConnectionResult } from './connection';

/**
 * The status line a "Test connection" button fills in (P1-T10). Always the same element
 * (`aria-live="polite"`) so a screen reader announces the change rather than the mount.
 *
 * A help step naming a command (`lms …`, `pnpm …`, `launchctl …`, `systemctl …`) shows
 * that part in `<code>`, so the wording stays copyable without changing `corsHelp`'s text.
 */
const COMMAND_PATTERN = /(lms\s[^\n]*|pnpm\s[^\n]*|launchctl\s[^\n]*|systemctl\s[^\n]*)/;

function renderStep(step: string): ReactElement {
  const parts = step.split(COMMAND_PATTERN);
  return (
    <li key={step}>
      {parts.map((part, index) =>
        part !== '' && COMMAND_PATTERN.test(part) ? <code key={index}>{part}</code> : <span key={index}>{part}</span>,
      )}
    </li>
  );
}

export interface ConnectionStatusProps {
  readonly pending: boolean;
  readonly result: ConnectionResult | null;
}

export function ConnectionStatus({ pending, result }: ConnectionStatusProps): ReactElement {
  const tone: 'ok' | 'warn' | 'danger' = pending ? 'warn' : (result?.tone ?? 'ok');
  const text = pending ? 'Testing…' : (result?.text ?? '');
  return (
    <div aria-live="polite" className="settings-status-region">
      {/* `tone` is a bare identifier here, never a literal — theme.test.ts's scanner
          would otherwise mistake a quoted fallback like `?? 'ok'` for a class of its own. */}
      {text !== '' && <p className={`settings-status settings-status-${tone}`}>{text}</p>}
      {!pending && result?.help !== undefined && (
        <ol className="settings-help-steps">{result.help.steps.map((step) => renderStep(step))}</ol>
      )}
    </div>
  );
}
