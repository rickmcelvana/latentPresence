import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Invoke } from '../desktop/desktop';
import { SHOW_WAIT_MS, browserNotifications, desktopNotifications } from './notifications';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A `Notification` that records what was constructed, with the permission the test gives it; each is an EventTarget the test fires on. */
function stubNotification(permission: string, options: { throws?: boolean; asks?: string } = {}) {
  const made: [string, NotificationOptions | undefined][] = [];
  const instances: Fake[] = [];
  class Fake extends EventTarget {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      if (options.asks === 'throw') throw new Error('not from a click');
      return options.asks ?? permission;
    });
    closed = false;
    constructor(title: string, init?: NotificationOptions) {
      super();
      if (options.throws === true) throw new TypeError('Illegal constructor');
      made.push([title, init]);
      instances.push(this);
    }
    close(): void {
      this.closed = true;
    }
  }
  vi.stubGlobal('Notification', Fake);
  return { made, instances, Fake };
}

describe('browserNotifications (P6-T08)', () => {
  it('reads the permission without asking', () => {
    for (const state of ['granted', 'denied', 'default'] as const) {
      const { Fake } = stubNotification(state);
      expect(browserNotifications().permission()).toBe(state);
      expect(Fake.requestPermission).not.toHaveBeenCalled();
    }
  });

  it('is unsupported where there is no Notification, and nothing throws', async () => {
    vi.stubGlobal('Notification', undefined);
    const notifications = browserNotifications();
    expect(notifications.permission()).toBe('unsupported');
    expect(await notifications.request()).toBe('unsupported');
    expect(await notifications.show('Alice', 'call the vet', 'r1')).toBe(false);
  });

  it('asks with the promise form and returns the answer; a throw is unsupported', async () => {
    const { Fake } = stubNotification('default', { asks: 'granted' });
    expect(await browserNotifications().request()).toBe('granted');
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
    stubNotification('default', { asks: 'throw' });
    expect(await browserNotifications().request()).toBe('unsupported');
  });

  it('shows one with the tag once its show event fires, and says false when the constructor throws (mobile)', async () => {
    const { made, instances } = stubNotification('granted');
    const shown = browserNotifications().show('Alice', 'call the vet', 'r1');
    instances[0]?.dispatchEvent(new Event('show'));
    expect(await shown).toBe(true);
    expect(made).toEqual([['Alice', { body: 'call the vet', tag: 'r1' }]]);
    stubNotification('granted', { throws: true });
    expect(await browserNotifications().show('Alice', 'call the vet', 'r1')).toBe(false);
  });

  it('says false on its error event: constructed is not shown (R-43)', async () => {
    const { instances } = stubNotification('granted');
    const shown = browserNotifications().show('Alice', 'call the vet', 'r1');
    instances[0]?.dispatchEvent(new Event('error'));
    expect(await shown).toBe(false);
  });

  it('takes the constructor at its word when neither event comes (neither is Baseline)', async () => {
    vi.useFakeTimers();
    stubNotification('granted');
    const shown = browserNotifications().show('Alice', 'call the vet', 'r1');
    await vi.advanceTimersByTimeAsync(SHOW_WAIT_MS);
    expect(await shown).toBe(true);
  });

  it('brings them back to her tab on a click and closes the notification', async () => {
    const { instances } = stubNotification('granted');
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const shown = browserNotifications().show('Alice', 'call the vet', 'r1');
    instances[0]?.dispatchEvent(new Event('show'));
    await shown;
    instances[0]?.dispatchEvent(new Event('click'));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(instances[0]?.closed).toBe(true);
  });
});

describe('a Notification stand-in with no events (the desktop plugin, P8-T01)', () => {
  it('counts as shown at once instead of throwing on addEventListener', async () => {
    // tauri-plugin-notification's polyfill: a plain function, sends the toast, has no events.
    const sent: string[] = [];
    function StandIn(this: unknown, title: string): void {
      sent.push(title);
    }
    StandIn.permission = 'granted';
    vi.stubGlobal('Notification', StandIn);
    expect(await browserNotifications().show('Alice', 'Stretch.', 's1')).toBe(true);
    expect(sent).toEqual(['Alice']);
  });
});

describe('desktopNotifications (P8-T01)', () => {
  it('sends to the plugin when Windows will draw the toast, and says granted', async () => {
    const invoke = vi.fn(async () => null) as unknown as Invoke;
    const notifications = desktopNotifications(invoke, true);
    expect(notifications.permission()).toBe('granted');
    expect(await notifications.show('Alice', 'Stretch.', 's1')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', { options: { title: 'Alice', body: 'Stretch.' } });
  });

  it('run from a build folder, sends nothing and says not shown, so she says it', async () => {
    const invoke = vi.fn(async () => null) as unknown as Invoke;
    const notifications = desktopNotifications(invoke, false);
    expect(notifications.permission()).toBe('unsupported');
    expect(await notifications.request()).toBe('unsupported');
    expect(await notifications.show('Alice', 'Stretch.', 's1')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('is not shown when the plugin refuses', async () => {
    const invoke = vi.fn(async () => Promise.reject(new Error('not allowed by ACL'))) as unknown as Invoke;
    expect(await desktopNotifications(invoke, true).show('Alice', 'Stretch.', 's1')).toBe(false);
  });

  // R-56 (2026-10-17): in the app the page reads visible while the window is minimised or behind
  // another app, so "hidden" never came and every reminder was hers to say.
  it('asks the window, not the page, whether they are away: not focused, or minimised', async () => {
    let focused = true;
    let minimised = false;
    const invoke = vi.fn(async (command: string) => (command === 'plugin:window|is_focused' ? focused : command === 'plugin:window|is_minimized' ? minimised : null)) as unknown as Invoke;
    const notifications = desktopNotifications(invoke, true);
    expect(await notifications.away()).toBe(false);
    focused = false;
    expect(await notifications.away()).toBe(true);
    // Minimised with nothing else to take the focus, Windows still calls it focused.
    focused = true;
    minimised = true;
    expect(await notifications.away()).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:window|is_focused', { label: 'main' });
    expect(invoke).toHaveBeenCalledWith('plugin:window|is_minimized', { label: 'main' });
  });

  it('falls back to the page when the window cannot be asked', async () => {
    const invoke = vi.fn(async () => Promise.reject(new Error('not allowed by ACL'))) as unknown as Invoke;
    expect(await desktopNotifications(invoke, true).away()).toBe(false);
  });
});

describe('browserNotifications().away', () => {
  it('is the page being hidden', async () => {
    expect(await browserNotifications().away()).toBe(false);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      expect(await browserNotifications().away()).toBe(true);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });
});
