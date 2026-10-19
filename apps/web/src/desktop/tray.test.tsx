import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initDesktop, listenShell, resetDesktopForTests, type Invoke } from './desktop';
import { setPresence, syncCloseToTray, useDesktopTray } from './tray';

type Handler = (event: { readonly payload: unknown }) => void;

/** The shell's event bus, as `window.__TAURI__.event` gives it: listen, and an emit for the test. */
function fakeEvents() {
  const handlers = new Map<string, Set<Handler>>();
  const listen = vi.fn(async (event: string, handler: Handler) => {
    const set = handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(event, set);
    return () => set.delete(handler);
  });
  const emit = (event: string, payload: unknown = null): void => {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  };
  const count = (event: string): number => handlers.get(event)?.size ?? 0;
  return { listen, emit, count };
}

const tauriWindow = window as unknown as { __TAURI__?: unknown };

afterEach(() => {
  cleanup();
  resetDesktopForTests();
  delete tauriWindow.__TAURI__;
});

async function inApp() {
  const events = fakeEvents();
  const invoke = vi.fn(async (command: string) => {
    if (command === 'companion_info') return { url: 'http://127.0.0.1:8790', token: 't' };
    if (command === 'os_notifications') return true;
    return null;
  });
  tauriWindow.__TAURI__ = { core: { invoke }, event: { listen: events.listen } };
  await initDesktop({ __TAURI__: { core: { invoke: invoke as unknown as Invoke } }, fetch: vi.fn() as unknown as typeof fetch });
  return { events, invoke };
}

function Probe({ onHidden }: { readonly onHidden: () => void }) {
  const tray = useDesktopTray(onHidden);
  return <output aria-label="tray">{`available=${String(tray.available)} presence=${String(tray.presence)}`}</output>;
}

describe('tray mode, the page side (P8-T05, ADR-65)', () => {
  it('in a browser: no shell, nothing listened to, nothing asked', () => {
    const onHidden = vi.fn();
    render(<Probe onHidden={onHidden} />);
    expect(screen.getByLabelText('tray').textContent).toBe('available=false presence=false');
    expect(() => {
      syncCloseToTray(false);
      setPresence(true);
    }).not.toThrow();
    expect(listenShell('tray-hidden', vi.fn())).toBeTypeOf('function');
  });

  it('hears the window go to the tray and the presence window come and go, and stops listening on unmount', async () => {
    const { events } = await inApp();
    const onHidden = vi.fn();
    const { unmount } = render(<Probe onHidden={onHidden} />);
    await vi.waitFor(() => expect(events.count('presence')).toBe(1));
    expect(screen.getByLabelText('tray').textContent).toBe('available=true presence=false');

    act(() => events.emit('tray-hidden'));
    expect(onHidden).toHaveBeenCalledTimes(1);
    act(() => events.emit('presence', true));
    expect(screen.getByLabelText('tray').textContent).toBe('available=true presence=true');
    act(() => events.emit('presence', false));
    expect(screen.getByLabelText('tray').textContent).toBe('available=true presence=false');

    unmount();
    expect(events.count('presence')).toBe(0);
    expect(events.count('tray-hidden')).toBe(0);
  });

  it('a listener stopped before the shell answered is still removed', async () => {
    const events = fakeEvents();
    const stop = listenShell('presence', vi.fn(), { __TAURI__: { event: { listen: events.listen } } });
    stop();
    await vi.waitFor(() => expect(events.listen).toHaveBeenCalled());
    await Promise.resolve();
    expect(events.count('presence')).toBe(0);
  });

  it('tells the shell the close setting and asks it for the presence window', async () => {
    const { invoke } = await inApp();
    syncCloseToTray(false);
    setPresence(true);
    expect(invoke).toHaveBeenCalledWith('tray_close_to_tray', { enabled: false });
    expect(invoke).toHaveBeenCalledWith('presence_set', { on: true });
  });
});
