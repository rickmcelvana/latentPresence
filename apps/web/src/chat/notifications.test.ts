import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHOW_WAIT_MS, browserNotifications } from './notifications';

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
