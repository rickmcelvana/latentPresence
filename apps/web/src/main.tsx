import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme.css';

const container = document.querySelector('#root');
if (!container) {
  throw new Error('index.html is missing the #root container');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
