import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@latentpresence/protocol';
import { App, CHAT_PATH, SETTINGS_PATH, WELCOME_PATH } from './App';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from './settings/settings';

afterEach(cleanup);

/**
 * How long a lazy route may take to import. `findBy`'s 1 s default is enough alone and
 * not under a full `pnpm gate`, where the AI SDK chunk behind `/settings` and `/chat`
 * competes with 80 other files for the transform; it failed there once (2026-09-22).
 * These tests are about the import happening, not about its speed.
 */
const LAZY = { timeout: 10_000 };

/** A settings document read from memory, so these tests never depend on jsdom's `localStorage`. */
function stored(welcomed: boolean): Pick<Storage, 'getItem'> {
  const document = JSON.stringify({ ...DEFAULT_SETTINGS, welcomed });
  return { getItem: (key: string) => (key === SETTINGS_STORAGE_KEY ? document : null) };
}

describe('App', () => {
  it('renders the boot screen with the protocol version the app is linked against', () => {
    // Fails if React, jsdom, or workspace package resolution from apps/web breaks —
    // the three things the scaffold has to keep working for every later task.
    const { container } = render(<App storage={stored(true)} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('latentPresence');
    expect(container.textContent).toContain(`protocol v${PROTOCOL_VERSION}`);
    expect(container.textContent).toContain('@latentpresence/core');
  });

  it('links to /settings from the boot screen', () => {
    render(<App storage={stored(true)} />);
    const link = screen.getByRole('link', { name: 'Settings' }) as HTMLAnchorElement;
    expect(new URL(link.href).pathname).toBe(SETTINGS_PATH);
  });

  it('renders the settings panel at /settings — it is lazy, so this awaits the import', async () => {
    render(<App path={SETTINGS_PATH} />);
    // The fallback renders first; `findBy` waits for the lazy import to resolve.
    const heading = await screen.findByRole('heading', { level: 1 }, LAZY);
    expect(heading.textContent).toBe('Settings');
    // P8-T02: a way back into the wizard.
    expect(new URL((screen.getByRole('link', { name: 'Run setup again' }) as HTMLAnchorElement).href).pathname).toBe(WELCOME_PATH);
    // A way out without the browser's Back (the app window has none): the page bar.
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = [...nav.querySelectorAll('a')].map((a) => [a.textContent, new URL(a.href).pathname, a.getAttribute('aria-current')]);
    expect(links).toEqual([
      ['latentPresence', CHAT_PATH, null],
      ['Chat', CHAT_PATH, null],
      ['Settings', SETTINGS_PATH, 'page'],
      ['Setup', WELCOME_PATH, null],
    ]);
    await act(async () => {});
  });

  it('renders /chat — it is lazy too, so this awaits the import', async () => {
    render(<App path={CHAT_PATH} />);
    const heading = await screen.findByRole('heading', { level: 1 }, LAZY);
    expect(heading.textContent).toBe('Chat');
    await act(async () => {});
  });

  it('shows the wizard at / until setup has been finished or skipped (P8-T02)', async () => {
    render(<App path="/" storage={stored(false)} />);
    const heading = await screen.findByRole('heading', { level: 1 }, LAZY);
    expect(heading.textContent).toBe('Welcome to latentPresence');
    expect(screen.queryByText(/Scaffold online/)).toBeNull();
    await act(async () => {});
  });

  it('leaves / as it was once welcomed', () => {
    render(<App path="/" storage={stored(true)} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('latentPresence');
  });

  it('shows the wizard at /welcome whether or not setup was finished', async () => {
    render(<App path={WELCOME_PATH} storage={stored(true)} />);
    expect((await screen.findByRole('heading', { level: 1 }, LAZY)).textContent).toBe('Welcome to latentPresence');
    await act(async () => {});
  });

  it('does not send other routes to the wizard', async () => {
    render(<App path={CHAT_PATH} storage={stored(false)} />);
    expect((await screen.findByRole('heading', { level: 1 }, LAZY)).textContent).toBe('Chat');
    await act(async () => {});
  });
});
