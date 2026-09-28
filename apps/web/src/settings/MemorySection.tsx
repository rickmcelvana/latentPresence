import type { ReactElement } from 'react';
import type { MemorySetting } from './settings';

export interface MemorySectionProps {
  readonly memory: MemorySetting;
  readonly onChange: (next: MemorySetting) => void;
}

const HINTS: Record<MemorySetting, string> = {
  auto: 'Asks the companion each visit: its database when it is running with one, this browser otherwise.',
  browser: 'Kept in this browser only. Another browser or computer starts from nothing.',
  companion: 'Kept in the companion’s database, shared by every browser that uses it. Nothing is remembered while it is not running.',
  off: 'She remembers nothing between visits, and within a visit only the conversation itself.',
};

/** Where she remembers what she learns about you (P4-T04b, ADR-38). */
export function MemorySection({ memory, onChange }: MemorySectionProps): ReactElement {
  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Memory</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="settings-memory">
          Remember in
        </label>
        <select className="select" id="settings-memory" onChange={(event) => onChange(event.target.value as MemorySetting)} value={memory}>
          <option value="browser">This browser</option>
          <option value="auto">Automatic</option>
          <option value="companion">The companion</option>
          <option value="off">Nowhere (off)</option>
        </select>
      </div>
      <p className="field-hint">{HINTS[memory]}</p>
    </section>
  );
}
