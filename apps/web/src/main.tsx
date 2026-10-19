import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initDesktop } from './desktop/desktop';
import { syncCloseToTray } from './desktop/tray';
import { checkAtStart } from './desktop/updates';
import { initCompanionPairing } from './settings/companion-pairing';
import { loadSettings } from './settings/settings';
import './theme.css';

const container = document.querySelector('#root');
if (!container) {
  throw new Error('index.html is missing the #root container');
}

// P8-T01: in the desktop app, learn where its companion is before anything reads settings or
// fetches; in a browser this resolves at once, and the companion's pairing code (P8-T03) is
// added to its requests instead.
void initDesktop().then((shell) => {
  if (shell === null) initCompanionPairing();
  // P8-T05: whether the close button hides to the tray (on unless turned off in Settings).
  else {
    const settings = loadSettings();
    syncCloseToTray(settings.closeToTray);
    // P8-T04: only when they turned it on.
    checkAtStart(settings.checkUpdates);
  }
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
