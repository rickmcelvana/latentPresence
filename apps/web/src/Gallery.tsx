import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

/**
 * Every primitive in `theme.css`, in every state, on one page.
 *
 * Two jobs. A person can look at the whole system at once and say whether it hangs
 * together, which is the click-through in the P0-T02b brief. And Playwright can
 * screenshot this route later, so a change to a token shows up as a diff rather than as
 * a screen nobody opened.
 *
 * Dev route only: `App` renders it when the path is `/gallery` and `import.meta.env.DEV`
 * is set, so it never reaches app.latentpresence.com.
 */

const SWATCHES = [
  'bg',
  'panel',
  'panel-hover',
  'border',
  'border-bright',
  'text',
  'text-muted',
  'accent',
  'accent-hover',
  'accent-dim',
  'on-accent',
  'danger',
  'success',
  'warning',
] as const;

export function Gallery(): ReactElement {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // On the document, not on the drawer: a keydown handler on the panel only fires
  // when focus is already inside it, which is exactly when the user least needs a
  // way out. The real drawers in P1-T10 inherit this behaviour.
  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [drawerOpen]);

  return (
    <div className="gallery">
      <header className="gallery-header">
        <h1>Design system</h1>
        <p className="gallery-note">
          Every primitive in <code>theme.css</code>, in every state. Tab through it: each
          interactive element must show the focus ring, and nothing may look unstyled.
        </p>
      </header>

      <section className="gallery-section">
        <h2>Tokens</h2>
        <div className="gallery-swatches">
          {SWATCHES.map((token) => (
            <div className="gallery-swatch" key={token}>
              <div className={`gallery-swatch-chip gallery-swatch-${token}`} />
              <span className="gallery-swatch-name">--{token}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="gallery-section">
        <h2>Typography</h2>
        <div className="panel">
          <h1>Heading one</h1>
          <h2>Heading two</h2>
          <h3>Heading three</h3>
          <p>
            Body copy at the base size, with <a href="#top">a link</a>, some{' '}
            <code>inline code</code>, and a <kbd>Ctrl</kbd> key.
          </p>
          <p className="panel-note">A muted note, for the second thing on a row.</p>
        </div>
      </section>

      <section className="gallery-section">
        <h2>Buttons</h2>
        <div className="gallery-row">
          <button className="btn btn-primary" type="button">
            Primary
          </button>
          <button className="btn" type="button">
            Default
          </button>
          <button className="btn btn-ghost" type="button">
            Ghost
          </button>
          <button className="btn btn-danger" type="button">
            Danger
          </button>
          <button className="btn btn-sm" type="button">
            Small
          </button>
        </div>
        <div className="gallery-row">
          <button className="btn btn-primary" type="button" disabled>
            Primary disabled
          </button>
          <button className="btn" type="button" disabled>
            Disabled
          </button>
          <button className="btn btn-ghost" type="button" disabled>
            Ghost disabled
          </button>
        </div>
      </section>

      <section className="gallery-section">
        <h2>Panels</h2>
        <div className="gallery-grid">
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Conversation</span>
              <span className="pill pill-ok">connected</span>
            </div>
            <p className="panel-note">A panel with a header and a status pill.</p>
          </div>
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Companion</span>
              <span className="pill pill-warn">not found</span>
            </div>
            <p className="panel-note">Panels stack their children with one gap.</p>
          </div>
        </div>
      </section>

      <section className="gallery-section">
        <h2>Inputs</h2>
        <div className="panel">
          <div className="gallery-grid">
            <label className="field">
              <span className="field-label">Base URL</span>
              <input className="input" defaultValue="http://127.0.0.1:11434" />
              <span className="field-hint">Ollama needs OLLAMA_ORIGINS set to reach it.</span>
            </label>

            <label className="field">
              <span className="field-label">API key</span>
              <input className="input" placeholder="Paste a key" type="password" />
            </label>

            <label className="field">
              <span className="field-label">Model</span>
              <select className="select" defaultValue="nemotron">
                <option value="nemotron">nemotron-3-nano</option>
                <option value="qwen">qwen3-omni</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">Invalid</span>
              <input aria-invalid="true" className="input" defaultValue="not-a-url" />
              <span className="field-error">That is not a URL.</span>
            </label>

            <label className="field">
              <span className="field-label">Disabled</span>
              <input className="input" defaultValue="Locked" disabled />
            </label>

            <label className="field">
              <span className="field-label">Persona</span>
              <textarea className="textarea" defaultValue="You are Alice." />
            </label>
          </div>
        </div>
      </section>

      <section className="gallery-section">
        <h2>Pills</h2>
        <div className="gallery-row">
          <span className="pill">neutral</span>
          <span className="pill pill-accent">listening</span>
          <span className="pill pill-ok">ready</span>
          <span className="pill pill-warn">degraded</span>
          <span className="pill pill-danger">failed</span>
        </div>
      </section>

      <section className="gallery-section">
        <h2>Drawer</h2>
        <div className="gallery-row">
          <button className="btn btn-primary" onClick={() => setDrawerOpen(true)} type="button">
            Open drawer
          </button>
          <span className="gallery-note">Escape and the scrim both close it.</span>
        </div>
      </section>

      {drawerOpen ? (
        <>
          <button
            aria-label="Close drawer"
            className="drawer-scrim"
            onClick={() => setDrawerOpen(false)}
            type="button"
          />
          <aside aria-label="Settings" className="drawer">
            <header className="drawer-header">
              <span className="drawer-title">Settings</span>
              <button className="btn btn-sm btn-ghost" onClick={() => setDrawerOpen(false)} type="button">
                Close
              </button>
            </header>
            <div className="drawer-body">
              <label className="field">
                <span className="field-label">Voice</span>
                <select className="select" defaultValue="af_heart">
                  <option value="af_heart">af_heart</option>
                </select>
              </label>
              <p className="panel-note">
                Drawers hold settings, schedules and the plan panel. One animation, one
                scrim, defined once.
              </p>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
