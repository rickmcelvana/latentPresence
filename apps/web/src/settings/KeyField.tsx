import { useState } from 'react';
import type { ReactElement } from 'react';
import type { Vault } from './vault';

/**
 * One key field, shared by the Language model, Voice and Hearing sections (P1-T10).
 *
 * A saved key never renders back: once `vault.hasKey(refKey)` is true this shows "Key
 * saved" and two buttons, never the key's text. The input itself is `type="password"`,
 * `autoComplete="off"`, `spellCheck={false}` — never logged, never in a URL, never in the
 * settings document (which has no field for one at all; see `settings.ts`).
 *
 * **A caller that lets `refKey` change under it (the language model section, switching
 * presets) must render this with `key={refKey}`.** That remounts the field instead of
 * patching it in place, so the initial `useState` reads *this* ref's saved-or-not state
 * again rather than carrying the previous endpoint's over.
 */
export interface KeyFieldProps {
  readonly id: string;
  readonly label: string;
  readonly refKey: string;
  readonly hint?: string | null;
  readonly optional?: boolean;
  readonly vault: Vault;
  /** Called after a successful save or a forget, so a parent that needs to know (to
   * enable "Test connection", say) can react. */
  readonly onChange?: () => void;
}

export function KeyField({ id, label, refKey, hint, optional, vault, onChange }: KeyFieldProps): ReactElement {
  const [saved, setSaved] = useState(() => vault.hasKey(refKey));
  const [editing, setEditing] = useState(() => !vault.hasKey(refKey));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    if (value === '') return;
    setBusy(true);
    try {
      await vault.saveKey(refKey, value);
      setSaved(true);
      setEditing(false);
      setValue('');
      onChange?.();
    } finally {
      setBusy(false);
    }
  }

  function forget(): void {
    vault.forgetKey(refKey);
    setSaved(false);
    setEditing(true);
    setValue('');
    onChange?.();
  }

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {optional === true ? ' (optional)' : ''}
      </label>
      {saved && !editing ? (
        <div className="settings-key-row">
          <span className="pill pill-ok">Key saved</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)} type="button">
            Replace
          </button>
          <button className="btn btn-sm btn-danger" onClick={forget} type="button">
            Forget
          </button>
        </div>
      ) : (
        <div className="settings-key-row">
          <input
            autoComplete="off"
            className="input"
            id={id}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste a key"
            spellCheck={false}
            type="password"
            value={value}
          />
          <button className="btn btn-sm" disabled={value === '' || busy} onClick={() => void save()} type="button">
            Save
          </button>
        </div>
      )}
      {hint !== null && hint !== undefined ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
