import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@latentpresence/protocol';
import { App, CHAT_PATH, SETTINGS_PATH } from './App';

afterEach(cleanup);

/**
 * How long a lazy route may take to import. `findBy`'s 1 s default is enough alone and
 * not under a full `pnpm gate`, where the AI SDK chunk behind `/settings` and `/chat`
 * competes with 80 other files for the transform; it failed there once (2026-09-22).
 * These tests are about the import happening, not about its speed.
 */
const LAZY = { timeout: 10_000 };

describe('App', () => {
  it('renders the boot screen with the protocol version the app is linked against', () => {
    // Fails if React, jsdom, or workspace package resolution from apps/web breaks —
    // the three things the scaffold has to keep working for every later task.
    const { container } = render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('latentPresence');
    expect(container.textContent).toContain(`protocol v${PROTOCOL_VERSION}`);
    expect(container.textContent).toContain('@latentpresence/core');
  });

  it('links to /settings from the boot screen', () => {
    render(<App />);
    const link = screen.getByRole('link', { name: 'Settings' }) as HTMLAnchorElement;
    expect(new URL(link.href).pathname).toBe(SETTINGS_PATH);
  });

  it('renders the settings panel at /settings — it is lazy, so this awaits the import', async () => {
    render(<App path={SETTINGS_PATH} />);
    // The fallback renders first; `findBy` waits for the lazy import to resolve.
    const heading = await screen.findByRole('heading', { level: 1 }, LAZY);
    expect(heading.textContent).toBe('Settings');
    await act(async () => {});
  });

  it('renders /chat — it is lazy too, so this awaits the import', async () => {
    render(<App path={CHAT_PATH} />);
    const heading = await screen.findByRole('heading', { level: 1 }, LAZY);
    expect(heading.textContent).toBe('Chat');
    await act(async () => {});
  });
});
