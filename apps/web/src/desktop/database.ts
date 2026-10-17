import type { Invoke } from './desktop';

/**
 * The database address in the desktop app (ADR-62). The shell keeps it in Windows Credential
 * Manager and hands it to the companion at each start; saving or forgetting one restarts the
 * companion on the same address and token, so nothing in the page has to reconnect. The page
 * never reads the address back with its password: `address` is the shell's redacted form.
 */
export interface DatabaseInfo {
  readonly saved: boolean;
  /** `mysql://user@host:3306/name`, the password left out; null when nothing is saved. */
  readonly address: string | null;
}

export interface DesktopDatabase {
  info(): Promise<DatabaseInfo>;
  /** Rejects with the shell's sentence when the address is not one (`mysql://…` with a host). */
  save(url: string): Promise<DatabaseInfo>;
  forget(): Promise<DatabaseInfo>;
}

export function desktopDatabase(invoke: Invoke): DesktopDatabase {
  return {
    info: () => invoke<DatabaseInfo>('database_info'),
    save: (url) => invoke<DatabaseInfo>('database_set', { url }),
    forget: () => invoke<DatabaseInfo>('database_clear'),
  };
}
