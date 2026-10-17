/**
 * The page's OS notifications (P6-T08, ADR-58 decision 5), behind a port so a test never touches
 * the browser's. Checked against MDN 2026-10-13 (`docs/SURFACE.md`, "Web Notifications"):
 * `Notification.requestPermission()` returns a promise, `Notification.permission` reads the answer
 * without asking, and **the constructor throws in nearly all mobile browsers** — so showing one
 * says whether it did, and a throw is "not shown": the run waits for her to say it.
 *
 * Permission is asked **only from a click** (the Schedules panel's button), never on load.
 *
 * A constructed notification is not yet a shown one (R-43): showing waits for its `show` event
 * (shown) or `error` event (not shown), MDN 2026-10-14. Neither is Baseline, so one that fires
 * neither within `SHOW_WAIT_MS` counts as shown, as the constructor alone did before. The OS may
 * still hold the banner back — Windows' Do Not Disturb files it in the notification centre — and
 * no page can see that: ADR-58 counts it as told.
 *
 * Clicking one brings them back to her tab. Focusing it is the default, which not every browser
 * does, so the page focuses itself and closes the notification.
 */

import { desktopShell, type Invoke } from '../desktop/desktop';

/** How long showing waits for `show` or `error` before taking the constructor's word for it. */
export const SHOW_WAIT_MS = 4000;

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface PageNotifications {
  permission(): NotificationPermissionState;
  /** Ask the browser; only ever called from a click. Resolves with the answer, `unsupported` when there is nobody to ask. */
  request(): Promise<NotificationPermissionState>;
  /**
   * Show one: true on its `show` event (or silence for `SHOW_WAIT_MS`), false on its `error` event or
   * any throw (the constructor throws on mobile). `tag` replaces an earlier one with the same tag.
   */
  show(title: string, body: string, tag: string): Promise<boolean>;
}

function supported(): boolean {
  return typeof Notification !== 'undefined';
}

function stateOf(value: unknown): NotificationPermissionState {
  return value === 'granted' || value === 'denied' || value === 'default' ? value : 'unsupported';
}

/** The browser's own. */
export function browserNotifications(): PageNotifications {
  return {
    permission: () => {
      try {
        return supported() ? stateOf(Notification.permission) : 'unsupported';
      } catch {
        return 'unsupported';
      }
    },
    request: async () => {
      if (!supported()) return 'unsupported';
      try {
        return stateOf(await Notification.requestPermission());
      } catch {
        return 'unsupported';
      }
    },
    show: (title, body, tag) => {
      if (!supported()) return Promise.resolve(false);
      let made: Notification;
      try {
        made = new Notification(title, { body, tag });
      } catch {
        return Promise.resolve(false);
      }
      // A stand-in for `Notification` (the desktop shell's plugin) may have no events at all: it was
      // sent, and nothing more can be learned.
      if (typeof made.addEventListener !== 'function') return Promise.resolve(true);
      made.addEventListener('click', () => {
        window.focus();
        made.close();
      });
      return new Promise<boolean>((resolve) => {
        const settle = (shown: boolean): void => {
          clearTimeout(timer);
          resolve(shown);
        };
        const timer = setTimeout(() => settle(true), SHOW_WAIT_MS);
        made.addEventListener('show', () => settle(true), { once: true });
        made.addEventListener('error', () => settle(false), { once: true });
      });
    },
  };
}

/**
 * The desktop app's (P8-T01): straight to tauri-plugin-notification, as its own `Notification`
 * stand-in does, minus the stand-in's missing events. Windows draws the app's toasts only once it
 * is installed (`os_notifications`); run from a build folder this says `unsupported`, so a
 * reminder is said by her rather than sent to a toast nobody will see. Shown means the OS took it.
 */
export function desktopNotifications(invoke: Invoke, osNotifications: boolean): PageNotifications {
  const state: NotificationPermissionState = osNotifications ? 'granted' : 'unsupported';
  return {
    permission: () => state,
    request: () => Promise.resolve(state),
    show: async (title, body) => {
      if (!osNotifications) return false;
      try {
        await invoke('plugin:notification|notify', { options: { title, body } });
        return true;
      } catch {
        return false;
      }
    },
  };
}

let browserOnes: PageNotifications | null = null;
let desktopOnes: PageNotifications | null = null;

/** The page's notifications: the desktop app's inside it, else the browser's. */
export function pageNotifications(): PageNotifications {
  const shell = desktopShell();
  if (shell !== null) {
    desktopOnes ??= desktopNotifications(shell.invoke, shell.osNotifications);
    return desktopOnes;
  }
  browserOnes ??= browserNotifications();
  return browserOnes;
}
