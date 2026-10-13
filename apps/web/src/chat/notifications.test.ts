import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNotifications } from './notifications';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `Notification` that records what was constructed, with the permission the test gives it. */
function stubNotification(permission: string, options: { throws?: boolean; asks?: string } = {}) {
  const made: [string, NotificationOptions | undefined][] = [];
  class Fake {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      if (options.asks === 'throw') throw new Error('not from a click');
      return options.asks ?? permission;
    });
    constructor(title: string, init?: NotificationOptions) {
      if (options.throws === true) throw new TypeError('Illegal constructor');
      made.push([title, init]);
    }
  }
  vi.stubGlobal('Notification', Fake);
  return { made, Fake };
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
    expect(notifications.show('Alice', 'call the vet', 'r1')).toBe(false);
  });

  it('asks with the promise form and returns the answer; a throw is unsupported', async () => {
    const { Fake } = stubNotification('default', { asks: 'granted' });
    expect(await browserNotifications().request()).toBe('granted');
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
    stubNotification('default', { asks: 'throw' });
    expect(await browserNotifications().request()).toBe('unsupported');
  });

  it('shows one with the tag, and says false when the constructor throws (mobile)', () => {
    const { made } = stubNotification('granted');
    expect(browserNotifications().show('Alice', 'call the vet', 'r1')).toBe(true);
    expect(made).toEqual([['Alice', { body: 'call the vet', tag: 'r1' }]]);
    stubNotification('granted', { throws: true });
    expect(browserNotifications().show('Alice', 'call the vet', 'r1')).toBe(false);
  });
});
