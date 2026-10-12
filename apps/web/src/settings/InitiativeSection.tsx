import type { ReactElement } from 'react';
import type { InitiativeSetting } from './settings';

export interface InitiativeSectionProps {
  readonly initiative: InitiativeSetting;
  readonly onChange: (next: InitiativeSetting) => void;
}

const HINTS: Record<InitiativeSetting, string> = {
  normal: 'She greets you when you come back, brings up a check-in she offered when it comes due, and now and then mentions a plan or something you told her — at most six times a day, never while you are talking or typing.',
  rare: 'She greets you when you come back and brings up a check-in she offered when it comes due — at most twice a day.',
  off: 'She never speaks first. Check-ins she offered wait until you say something.',
};

/** How often she speaks up on her own (P6-T03, ADR-52). Needs memory: that is where what she has to say comes from. */
export function InitiativeSection({ initiative, onChange }: InitiativeSectionProps): ReactElement {
  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Speaking up</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="settings-initiative">
          She speaks first
        </label>
        <select className="select" id="settings-initiative" onChange={(event) => onChange(event.target.value as InitiativeSetting)} value={initiative}>
          <option value="normal">Normally</option>
          <option value="rare">Rarely</option>
          <option value="off">Never (off)</option>
        </select>
      </div>
      <p className="field-hint">{HINTS[initiative]}</p>
    </section>
  );
}
