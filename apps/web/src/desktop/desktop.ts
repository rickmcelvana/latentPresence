/**
 * The page inside the desktop app (P8-T01, ADR-60).
 *
 * The same build runs in a browser and in the Tauri window; only the window has
 * `window.__TAURI__` (`withGlobalTauri`). There the shell runs the companion in its own process,
 * on a port it picked, paired by a token made fresh at each launch. `initDesktop`, awaited
 * before the first render, asks the shell for both and then:
 *
 * - **adds the token to every request to the companion** — memory, tools, documents, schedules,
 *   the relay, every health check — by wrapping `window.fetch` once. Wrapping the global, rather
 *   than handing each caller a fetch, is deliberate: a companion call that forgot its `fetch`
 *   option would get a 401 in the app only, and nothing in a browser test would ever show it.
 *   The wrapper touches no other request.
 * - **sends local Ollama and LM Studio through the companion's relay.** Ollama refuses the
 *   window's origin (`http://tauri.localhost`, 403, Ollama 0.40.5, 2026-10-16) and LM Studio
 *   answers no page until CORS is on; through the relay neither needs `OLLAMA_ORIGINS` or a
 *   setting. The companion allows exactly these servers (`Relay::desktop`).
 * - **keeps API keys in Windows Credential Manager** (`KeychainVault`), not in the webview.
 *
 * Outside the app all of this is null and nothing changes.
 */

import type { HttpFetch } from '@latentpresence/providers/web';

/** Matches `TOKEN_HEADER` in `companion/crates/server/src/pairing.rs`. */
export const COMPANION_TOKEN_HEADER = 'x-lp-companion-token';
/** Matches `TARGET_HEADER` in `companion/crates/server/src/relay.rs`. */
const RELAY_TARGET_HEADER = 'x-lp-target';

/** The model servers on this machine the companion's desktop relay may reach. */
const LOCAL_MODEL_PORTS = new Set(['11434', '1234']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface DesktopShell {
  /** Where this app's companion listens, e.g. `http://127.0.0.1:8787`. */
  readonly companionUrl: string;
  readonly token: string;
  readonly invoke: Invoke;
}

interface TauriGlobal {
  readonly core?: { readonly invoke?: Invoke };
}

let shell: DesktopShell | null = null;

/** The shell, once `initDesktop` found one; null in a browser. */
export function desktopShell(): DesktopShell | null {
  return shell;
}

/** `invoke` when this page is in the desktop window. */
export function tauriInvoke(scope: { readonly __TAURI__?: TauriGlobal } = window as unknown as { readonly __TAURI__?: TauriGlobal }): Invoke | null {
  return scope.__TAURI__?.core?.invoke ?? null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True for a URL on this machine's Ollama or LM Studio port. */
export function isLocalModelServer(url: URL): boolean {
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) && LOCAL_MODEL_PORTS.has(url.port);
}

/**
 * `base` with the desktop's two rules: the token on every request to the companion, and local
 * model servers reached through its relay. Everything else passes through untouched.
 */
export function desktopFetch(base: HttpFetch, companion: Pick<DesktopShell, 'companionUrl' | 'token'>): HttpFetch {
  const companionOrigin = originOf(companion.companionUrl);
  const relay = `${companion.companionUrl.replace(/\/+$/, '')}/relay`;
  return (input, init) => {
    let url: URL;
    try {
      url = new URL(typeof input === 'string' ? input : input.toString());
    } catch {
      return base(input, init);
    }
    if (url.origin === companionOrigin) {
      const headers = new Headers(init?.headers);
      headers.set(COMPANION_TOKEN_HEADER, companion.token);
      return base(input, { ...init, headers });
    }
    if (isLocalModelServer(url)) {
      const headers = new Headers(init?.headers);
      headers.set(RELAY_TARGET_HEADER, url.toString());
      headers.set(COMPANION_TOKEN_HEADER, companion.token);
      return base(relay, { ...init, headers });
    }
    return base(input, init);
  };
}

/**
 * Asks the shell for its companion and installs the fetch wrapper. In a browser it returns null
 * at once. A shell that does not answer is said in the console and the page runs as in a
 * browser: without the companion, rather than not at all.
 */
export async function initDesktop(
  scope: { readonly __TAURI__?: TauriGlobal; fetch: typeof fetch } = window as unknown as { readonly __TAURI__?: TauriGlobal; fetch: typeof fetch },
): Promise<DesktopShell | null> {
  const invoke = tauriInvoke(scope);
  if (invoke === null) return null;
  try {
    const info = await invoke<{ url: string; token: string }>('companion_info');
    shell = { companionUrl: info.url, token: info.token, invoke };
  } catch (error) {
    console.warn('latentPresence: the desktop shell did not say where its companion is; running without it.', error);
    return null;
  }
  const plain = scope.fetch.bind(scope);
  const wrapped = desktopFetch((input, init) => plain(input, init), shell);
  scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    input instanceof Request ? plain(input, init) : wrapped(input, init)) as typeof fetch;
  return shell;
}

/** For tests: forget the shell. */
export function resetDesktopForTests(): void {
  shell = null;
}
