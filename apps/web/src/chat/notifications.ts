/**
 * The page's OS notifications (P6-T08, ADR-58 decision 5), behind a port so a test never touches
 * the browser's. Checked against MDN 2026-10-13 (`docs/SURFACE.md`, "Web Notifications"):
 * `Notification.requestPermission()` returns a promise, `Notification.permission` reads the answer
 * without asking, and **the constructor throws in nearly all mobile browsers** — so showing one
 * says whether it did, and a throw is "not shown": the run waits for her to say it.
 *
 * Permission is asked **only from a click** (the Schedules panel's button), never on load.
 */

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface PageNotifications {
  permission(): NotificationPermissionState;
  /** Ask the browser; only ever called from a click. Resolves with the answer, `unsupported` when there is nobody to ask. */
  request(): Promise<NotificationPermissionState>;
  /** Show one; false on any throw (the constructor throws on mobile). `tag` replaces an earlier one with the same tag. */
  show(title: string, body: string, tag: string): boolean;
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
      if (!supported()) return false;
      try {
        const shown = new Notification(title, { body, tag });
        return shown instanceof Notification;
      } catch {
        return false;
      }
    },
  };
}
