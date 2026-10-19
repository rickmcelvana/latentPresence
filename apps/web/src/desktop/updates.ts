import { pageNotifications } from '../chat/notifications';
import { desktopShell, listenShell, type Invoke } from './desktop';

/**
 * Updates, the page's side (P8-T04, ADR-66; the shell's is `src-tauri/src/updates.rs`).
 *
 * Nothing is asked of GitHub unless the person presses Check, or turned on "Check for updates
 * when the app starts" in Settings → This app (off by default: a check is a request to a server
 * they did not point anywhere). Installing ends the app; the installer opens the new version.
 */

export interface UpdateInfo {
  readonly version: string;
  readonly currentVersion: string;
  readonly notes: string | null;
}

export interface UpdateProgress {
  readonly downloaded: number;
  readonly total: number | null;
}

export interface UpdatesApi {
  version(): Promise<string>;
  /** Null when this is the newest. Rejects with the shell's sentence. */
  check(): Promise<UpdateInfo | null>;
  /** Downloads, verifies and starts the installer; the app ends before this resolves. */
  install(): Promise<void>;
  /** Download progress while installing; returns how to stop listening. */
  onProgress(handler: (progress: UpdateProgress) => void): () => void;
}

export function updatesApi(invoke: Invoke, listen: typeof listenShell = listenShell): UpdatesApi {
  return {
    version: () => invoke<string>('app_version'),
    check: () => invoke<UpdateInfo | null>('update_check'),
    install: () => invoke<void>('update_install'),
    onProgress: (handler) => listen('update-progress', (payload) => handler(payload as UpdateProgress)),
  };
}

/** The shell's, in the desktop app; null in a browser. */
export function desktopUpdates(): UpdatesApi | null {
  const shell = desktopShell();
  return shell === null ? null : updatesApi(shell.invoke);
}

/** How long after start the optional check waits, so it never competes with the first answer. */
export const START_CHECK_DELAY_MS = 15_000;

/**
 * The check at start, when they turned it on: a newer version is a notification pointing at
 * Settings → This app. A failed check is only logged — no network, no news.
 */
export function checkAtStart(
  enabled: boolean,
  api: UpdatesApi | null = desktopUpdates(),
  notify: (title: string, body: string) => Promise<boolean> = (title, body) => pageNotifications().show(title, body, 'update'),
  delayMs: number = START_CHECK_DELAY_MS,
): void {
  if (!enabled || api === null) return;
  setTimeout(() => {
    api.check().then(
      (found) => {
        if (found !== null) void notify(`latentPresence ${found.version} is ready`, 'Install it from Settings → This app.');
      },
      (error: unknown) => console.warn('latentPresence: the update check failed', error),
    );
  }, delayMs);
}
