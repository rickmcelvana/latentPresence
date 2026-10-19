import type { HttpFetch } from '@latentpresence/providers/web';
import { COMPANION_TOKEN_HEADER } from '../desktop/desktop';
import { loadSettings } from './settings';

/**
 * The companion's pairing code, in a browser (P8-T03, ADR-64).
 *
 * A companion started with `pnpm companion` answers the hosted app only when each request
 * carries its pairing code (it prints the code when it starts; pages on this computer need
 * none). The page keeps the code it was given and adds it to every request to the companion's
 * address — memory, tools, documents, the relay — by wrapping `window.fetch` once, as the desktop
 * app does with its own token (`desktop.ts`).
 *
 * **Kept in `localStorage`, not the vault.** The code already sits in a plain file beside
 * `mcp.json` that any program on the computer can read, and any script running as this site
 * could decrypt the vault as easily as read storage; the vault would add a step, not a lock.
 */

export const PAIRING_STORAGE_KEY = 'latentPresence.companionPairing';

/** What a companion says when the code is missing or wrong. Matches `PAIRING_NEEDED` in
 * `companion/crates/server/src/pairing.rs`. */
export const PAIRING_NEEDED = 'pairing code needed';

/** As the companion compares it: letters and digits, upper case. */
export function normalisePairingCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function loadPairingCode(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    const code = storage.getItem(PAIRING_STORAGE_KEY);
    return code === null || code === '' ? null : code;
  } catch {
    return null;
  }
}

/** `null` forgets it. */
export function savePairingCode(storage: Pick<Storage, 'setItem' | 'removeItem'>, code: string | null): void {
  const normalised = code === null ? '' : normalisePairingCode(code);
  if (normalised === '') storage.removeItem(PAIRING_STORAGE_KEY);
  else storage.setItem(PAIRING_STORAGE_KEY, normalised);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface PairingSource {
  /** The companion's address, read at each request: Settings can change it. */
  readonly companionUrl: () => string;
  readonly code: () => string | null;
}

/** `base` with the pairing code on every request to the companion; nothing else is touched. */
export function pairingFetch(base: HttpFetch, source: PairingSource): HttpFetch {
  return (input, init) => {
    const code = source.code();
    if (code === null) return base(input, init);
    const target = originOf(typeof input === 'string' ? input : input.toString());
    if (target === null || target !== originOf(source.companionUrl())) return base(input, init);
    const headers = new Headers(init?.headers);
    headers.set(COMPANION_TOKEN_HEADER, code);
    return base(input, { ...init, headers });
  };
}

/** Installs the wrapper in a browser. The desktop app has its own (`initDesktop`) and skips this. */
export function initCompanionPairing(scope: { fetch: typeof fetch; localStorage: Storage } = window): void {
  const plain = scope.fetch.bind(scope);
  const wrapped = pairingFetch((input, init) => plain(input, init), {
    companionUrl: () => loadSettings(scope.localStorage).companionUrl,
    code: () => loadPairingCode(scope.localStorage),
  });
  scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    input instanceof Request ? plain(input, init) : wrapped(input, init)) as typeof fetch;
}
