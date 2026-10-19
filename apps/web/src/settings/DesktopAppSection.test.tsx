import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAtStart, updatesApi, type UpdateInfo, type UpdateProgress, type UpdatesApi } from '../desktop/updates';
import { DesktopAppSection } from './DesktopAppSection';

afterEach(cleanup);

const NEXT: UpdateInfo = { version: '0.1.1', currentVersion: '0.1.0', notes: 'Tray mode and updates.' };

function fakeUpdates(found: UpdateInfo | null | Error) {
  let progress: ((progress: UpdateProgress) => void) | null = null;
  const api: UpdatesApi & { readonly checks: number[]; readonly installs: number[] } = {
    checks: [],
    installs: [],
    version: async () => '0.1.0',
    check: async () => {
      api.checks.push(1);
      if (found instanceof Error) throw found;
      return found;
    },
    install: vi.fn(async () => {
      api.installs.push(1);
      progress?.({ downloaded: 5, total: 10 });
      // The app ends here; the promise never settles in real life.
      await new Promise(() => undefined);
    }),
    onProgress: (handler) => {
      progress = handler;
      return () => {
        progress = null;
      };
    },
  };
  return api;
}

function mount(api: UpdatesApi | null, checkUpdates = false) {
  const onCheckUpdatesChange = vi.fn();
  render(<DesktopAppSection checkUpdates={checkUpdates} closeToTray onChange={vi.fn()} onCheckUpdatesChange={onCheckUpdatesChange} updates={api} />);
  return { onCheckUpdatesChange };
}

describe('Settings → This app: updates (P8-T04, ADR-66)', () => {
  it('shows the version, asks nothing until Check, and says when this is the newest', async () => {
    const api = fakeUpdates(null);
    mount(api);
    expect(await screen.findByText('This is version 0.1.0.')).toBeTruthy();
    expect(api.checks).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('You have the newest version.')).toBeTruthy();
    expect(api.checks).toHaveLength(1);
  });

  it('a newer version shows its notes and installs only on a press, with the download progress', async () => {
    const api = fakeUpdates(NEXT);
    mount(api);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Version 0.1.1 is ready.')).toBeTruthy();
    expect(screen.getByText('Tray mode and updates.')).toBeTruthy();
    expect(api.installs).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(await screen.findByText('Downloading… 50%')).toBeTruthy();
    expect(api.installs).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a failed check says the shell\'s sentence', async () => {
    mount(fakeUpdates(new Error('The update could not be checked or installed: offline')));
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('The update could not be checked or installed: offline')).toBeTruthy();
  });

  it('the check at start is a switch, off unless turned on', () => {
    const { onCheckUpdatesChange } = mount(fakeUpdates(null));
    const box = screen.getByLabelText('Check for updates when the app starts') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onCheckUpdatesChange).toHaveBeenCalledWith(true);
  });

  it('without a shell (a browser) there is no updates part', () => {
    mount(null);
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  });
});

describe('the check at start (P8-T04)', () => {
  it('asks nothing when off; when on, a newer version is a notification, after the delay', async () => {
    vi.useFakeTimers();
    try {
      const off = fakeUpdates(NEXT);
      const notify = vi.fn(async () => true);
      checkAtStart(false, off, notify, 1000);
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(off.checks).toHaveLength(0);

      const on = fakeUpdates(NEXT);
      checkAtStart(true, on, notify, 1000);
      expect(on.checks).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(on.checks).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith('latentPresence 0.1.1 is ready', 'Install it from Settings → This app.');

      const newest = fakeUpdates(null);
      notify.mockClear();
      checkAtStart(true, newest, notify, 0);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('talks to the shell by its command names', async () => {
    const invoke = vi.fn(async () => null) as unknown as Parameters<typeof updatesApi>[0];
    const api = updatesApi(invoke, () => () => undefined);
    await api.version();
    await api.check();
    await api.install();
    expect((invoke as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual(['app_version', 'update_check', 'update_install']);
  });
});
