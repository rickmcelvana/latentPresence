import type { ReactElement } from 'react';
import { SettingsPanel } from './SettingsPanel';

/** `/settings` (P1-T10): ships in production, lazy-loaded from `App.tsx` so the boot
 * screen does not wait for the AI SDK chunk this page pulls in. */
export function SettingsPage(): ReactElement {
  return (
    <main className="settings-page">
      <header className="settings-header">
        <h1>Settings</h1>
        <p className="settings-page-note">
          Configure a language model, a voice and a way to listen. Nothing here is sent anywhere unless you point it
          somewhere yourself.
        </p>
      </header>
      <SettingsPanel />
    </main>
  );
}
