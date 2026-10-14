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
