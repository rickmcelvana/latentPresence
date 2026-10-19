import { useEffect, useRef, useState } from 'react';
import { desktopShell, listenShell } from './desktop';

/**
 * Tray mode, the page's side (P8-T05, ADR-65; the shell's is `src-tauri/src/tray.rs`).
 *
 * - The close button hides the window to the tray unless Settings says otherwise; the shell is
 *   told the setting at start and on each change (`syncCloseToTray`).
 * - When the window is hidden the shell says `tray-hidden`, and the chat page ends anything that
 *   listens or watches — a call, the camera, face reading — and the voice it was speaking with.
 * - The presence window is the same window made small and kept on top; the shell says `presence`
 *   with `true` or `false`, from its menu or the page's own button (`setPresence`).
 *
 * In a browser there is no shell: nothing is sent, and nothing here does anything.
 */

export function syncCloseToTray(enabled: boolean): void {
  const shell = desktopShell();
  if (shell === null) return;
  void shell.invoke('tray_close_to_tray', { enabled }).catch((error: unknown) => console.warn('latentPresence: the shell did not take the close setting', error));
}

export function setPresence(on: boolean): void {
  const shell = desktopShell();
  if (shell === null) return;
  void shell.invoke('presence_set', { on }).catch((error: unknown) => console.warn('latentPresence: the presence window could not change', error));
}

export interface DesktopTray {
  /** The desktop app (so the page offers the small window at all). */
  readonly available: boolean;
  /** The window is the small, always-on-top one. */
  readonly presence: boolean;
}

/** The presence state, and `onHidden` called each time the window goes to the tray. */
export function useDesktopTray(onHidden: () => void): DesktopTray {
  const [presence, setPresenceState] = useState(false);
  const hidden = useRef(onHidden);
  useEffect(() => {
    hidden.current = onHidden;
  }, [onHidden]);
  useEffect(() => {
    const stopHidden = listenShell('tray-hidden', () => hidden.current());
    const stopPresence = listenShell('presence', (payload) => setPresenceState(payload === true));
    return () => {
      stopHidden();
      stopPresence();
    };
  }, []);
  return { available: desktopShell() !== null, presence };
}
