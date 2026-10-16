import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initDesktop } from './desktop/desktop';
import './theme.css';

const container = document.querySelector('#root');
if (!container) {
  throw new Error('index.html is missing the #root container');
}

// P8-T01: in the desktop app, learn where its companion is before anything reads settings or
// fetches; in a browser this resolves at once.
void initDesktop().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
