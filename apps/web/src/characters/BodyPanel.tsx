import { useState } from 'react';
import type { ReactElement } from 'react';
import { BUILT_IN_BODIES } from './bodies';
import type { OwnBody } from './body-shelf';

/**
 * The Body view (P7-T02, ADR-59): what she looks like, chosen in the call. The built-in bodies
 * and the person's own `.vrm` files, each worn with one press — the stage swaps it live, and the
 * conversation goes on. A file is checked before it is kept: one the call cannot drive is
 * refused with the reason, and one missing some expressions is kept with what it cannot show.
 */
export interface BodyPanelProps {
  readonly characterName: string;
  /** The body she is wearing (its id). */
  readonly wearing: string;
  /** Her pack's default, marked as such. */
  readonly defaultBody: string;
  /** The shelf, oldest first; null while it is being read. */
  readonly own: readonly OwnBody[] | null;
  readonly onWear: (id: string) => void;
  /** Checks and keeps a file, and wears it. Rejects with the reason a file is refused. */
  readonly onAdd: (file: File) => Promise<void>;
  readonly onRemove: (id: string) => Promise<void>;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

const MOUTH = new Set(['aa', 'ih', 'ou', 'ee', 'oh']);

/** What a body's missing presets mean in the call, in words. */
export function missingWords(missing: readonly string[]): string | null {
  const parts: string[] = [];
  if (missing.includes('blink')) parts.push('blinking');
  if (missing.some((preset) => MOUTH.has(preset))) parts.push('lip sync');
  const feelings = missing.filter((preset) => preset !== 'blink' && !MOUTH.has(preset));
  if (feelings.length > 0) parts.push(`looking ${feelings.join(', ')}`);
  return parts.length === 0 ? null : `Cannot show ${parts.join('; ')}.`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BodyPanel({ characterName, wearing, defaultBody, own, onWear, onAdd, onRemove }: BodyPanelProps): ReactElement {
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function add(file: File): Promise<void> {
    setProblem(null);
    setAdding(true);
    try {
      await onAdd(file);
    } catch (error) {
      setProblem(`${file.name}: ${messageOf(error)}`);
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setProblem(null);
    try {
      await onRemove(id);
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  const wearButton = (id: string, name: string): ReactElement =>
    id === wearing ? (
      <span className="pill pill-ok">Wearing</span>
    ) : (
      <button aria-label={`Wear ${name}`} className="btn btn-sm" onClick={() => onWear(id)} type="button">
        Wear
      </button>
    );

  return (
    <section aria-label={`${characterName}’s body`} className="panel bodies-panel">
      <div className="panel-header">
        <span className="panel-title">Body</span>
      </div>
      <div className="bodies-body">
        <p className="bodies-hint">What {characterName} looks like. Changing it keeps the conversation going.</p>
        <ul aria-label="Built in" className="bodies-list">
          {BUILT_IN_BODIES.map((body) => (
            <li className="bodies-item" key={body.id}>
              <span className="bodies-title">{body.name}</span>
              <span className="bodies-meta">
                {megabytes(body.asset.bytes)} · {body.asset.licence}
                {body.id === defaultBody ? ' · her default' : ''}
              </span>
              <div className="bodies-actions">{wearButton(body.id, body.name)}</div>
            </li>
          ))}
        </ul>

        <span className="bodies-heading">Your own</span>
        {own === null ? null : own.length === 0 ? (
          <p className="bodies-hint">None yet. A VRM model from your computer can be added below.</p>
        ) : (
          <ul aria-label="Your own" className="bodies-list">
            {own.map((body) => {
              const cannot = missingWords(body.missing);
              return (
                <li className="bodies-item" key={body.id}>
                  <span className="bodies-title">{body.name}</span>
                  <span className="bodies-meta">
                    {megabytes(body.bytes)} · {body.fileName}
                    {body.authors.length > 0 ? ` · by ${body.authors.join(', ')}` : ''}
                  </span>
                  {cannot !== null && <span className="bodies-missing">{cannot}</span>}
                  <div className="bodies-actions">
                    {wearButton(body.id, body.name)}
                    <button aria-label={`Remove ${body.name}`} className="btn btn-sm btn-ghost" onClick={() => void remove(body.id)} type="button">
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="bodies-add">
          <label className={`btn btn-sm ${adding ? 'bodies-add-busy' : ''}`}>
            {adding ? 'Checking…' : 'Add a .vrm…'}
            <input
              accept=".vrm,model/gltf-binary"
              aria-label="Add a VRM body from this computer"
              className="bodies-file"
              disabled={adding}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file !== undefined) void add(file);
              }}
              type="file"
            />
          </label>
          <span className="bodies-hint">It stays in this browser. Nothing is uploaded.</span>
        </div>
        {problem !== null && (
          <p className="bodies-error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </section>
  );
}
