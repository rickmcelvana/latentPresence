import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpFetch } from '@latentpresence/providers/web';
import type { DatabaseInfo, DesktopDatabase } from '../desktop/database';
import { CompanionDatabase } from './CompanionDatabase';

afterEach(cleanup);

const SECRET = 'mysql://lp:s3cret-pw@192.168.1.5:3306/latentpresence';
const SHOWN = 'mysql://lp@192.168.1.5:3306/latentpresence';

/** The shell's commands over one saved address, as Credential Manager would hold it. */
function fakeDatabase(initial: string | null = null) {
  let stored = initial;
  const shown = (): DatabaseInfo => ({ saved: stored !== null, address: stored === null ? null : SHOWN });
  const database: DesktopDatabase = {
    info: vi.fn(async () => shown()),
    save: vi.fn(async (url: string) => {
      if (!url.startsWith('mysql://')) throw new Error('A MariaDB address starts with mysql:// (or mariadb://).');
      stored = url;
      return shown();
    }),
    forget: vi.fn(async () => {
      stored = null;
      return shown();
    }),
  };
  return { database, stored: () => stored };
}

/** `/health` as a restarting companion answers it: refused `down` times, then with `database`. */
function restarting(down: number, database: { kind: 'mariadb' | 'none'; connected: boolean }): HttpFetch {
  let calls = 0;
  return (async () => {
    calls += 1;
    if (calls <= down) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ status: 'ok', service: 'latentpresence-companion', version: '0.0.0', database }), { status: 200 });
  }) as HttpFetch;
}

describe('CompanionDatabase (ADR-62)', () => {
  it('saves the address, waits for the restarted companion, says it connected, and never shows the password', async () => {
    const { database, stored } = fakeDatabase();
    const { container } = render(
      <CompanionDatabase companionUrl="http://127.0.0.1:8790" database={database} fetch={restarting(2, { kind: 'mariadb', connected: true })} pollMs={1} />,
    );
    const field = await screen.findByLabelText('Database address');
    expect(field.getAttribute('type')).toBe('password');
    fireEvent.change(field, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText(/Connected/)).toBeTruthy());
    expect(stored()).toBe(SECRET);
    expect(screen.getByText(SHOWN)).toBeTruthy();
    expect(container.innerHTML).not.toContain('s3cret-pw');
  });

  it('Enter saves too', async () => {
    const { database } = fakeDatabase();
    render(<CompanionDatabase companionUrl="http://127.0.0.1:8790" database={database} fetch={restarting(0, { kind: 'mariadb', connected: true })} pollMs={1} />);
    const field = await screen.findByLabelText('Database address');
    fireEvent.change(field, { target: { value: SECRET } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(database.save).toHaveBeenCalledWith(SECRET));
  });

  it("shows the shell's sentence for an address that is not one, and keeps the field", async () => {
    const { database } = fakeDatabase();
    render(<CompanionDatabase companionUrl="http://127.0.0.1:8790" database={database} fetch={restarting(0, { kind: 'none', connected: false })} pollMs={1} />);
    fireEvent.change(await screen.findByLabelText('Database address'), { target: { value: 'postgres://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/starts with mysql:\/\//)).toBeTruthy();
    expect(screen.getByLabelText('Database address')).toBeTruthy();
  });

  it('a saved address that does not connect says to fix it and save again', async () => {
    const { database } = fakeDatabase();
    render(<CompanionDatabase companionUrl="http://127.0.0.1:8790" database={database} fetch={restarting(0, { kind: 'mariadb', connected: false })} pollMs={1} />);
    fireEvent.change(await screen.findByLabelText('Database address'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/could not connect/)).toBeTruthy();
    expect(screen.getByText(/Save it again/)).toBeTruthy();
  });

  it('opens on a saved address with Replace and Forget; Forget clears it and restarts', async () => {
    const { database, stored } = fakeDatabase(SECRET);
    render(<CompanionDatabase companionUrl="http://127.0.0.1:8790" database={database} fetch={restarting(1, { kind: 'none', connected: false })} pollMs={1} />);
    expect(await screen.findByText(SHOWN)).toBeTruthy();
    expect(screen.queryByLabelText('Database address')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(screen.getByText(/No database address is saved yet/)).toBeTruthy());
    expect(stored()).toBeNull();
    expect(screen.getByLabelText('Database address')).toBeTruthy();
  });

  it('says the companion did not come back when it never answers', async () => {
    const { database } = fakeDatabase();
    render(<CompanionDatabase companionUrl="http://127.0.0.1:8790" database={database} fetch={restarting(1000, { kind: 'mariadb', connected: true })} pollMs={1} waitMs={20} />);
    fireEvent.change(await screen.findByLabelText('Database address'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/companion did not answer/)).toBeTruthy();
  });
});

describe('Settings → Memory, in the app (ADR-62)', () => {
  it('shows the database address with the companion or Automatic, and not otherwise or in a browser', async () => {
    const { database } = fakeDatabase();
    const fetch = restarting(0, { kind: 'none', connected: false });
    const { MemorySection } = await import('./MemorySection');
    const view = render(<MemorySection companionUrl="http://127.0.0.1:8790" database={database} fetch={fetch} memory="companion" onChange={() => {}} />);
    expect(await screen.findByLabelText('Database address')).toBeTruthy();
    view.rerender(<MemorySection companionUrl="http://127.0.0.1:8790" database={database} fetch={fetch} memory="auto" onChange={() => {}} />);
    expect(await screen.findByLabelText('Database address')).toBeTruthy();
    view.rerender(<MemorySection companionUrl="http://127.0.0.1:8790" database={database} fetch={fetch} memory="browser" onChange={() => {}} />);
    expect(screen.queryByLabelText('Database address')).toBeNull();
    view.unmount();
    // A browser: no shell, so no field — the companion there reads its own .env.
    render(<MemorySection companionUrl="http://127.0.0.1:8787" fetch={fetch} memory="companion" onChange={() => {}} />);
    expect(screen.queryByLabelText('Database address')).toBeNull();
  });
});
