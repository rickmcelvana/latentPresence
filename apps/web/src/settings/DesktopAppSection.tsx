import type { ReactElement } from 'react';

/**
 * Settings → This app, in the desktop app only (P8-T05, ADR-65): what the close button does.
 */
export interface DesktopAppSectionProps {
  readonly closeToTray: boolean;
  readonly onChange: (closeToTray: boolean) => void;
}

export function DesktopAppSection({ closeToTray, onChange }: DesktopAppSectionProps): ReactElement {
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
    </section>
  );
}
