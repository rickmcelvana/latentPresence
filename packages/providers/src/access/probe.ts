import type { HttpFetch } from '../llm/discovery';
import { localNetworkNeeded, localNetworkPermission, type PermissionsLike } from './local-network';

/**
 * What a page learns by calling a URL (P1-T10).
 *
 * In a browser a CORS refusal and a server that is not there fail identically — both are
 * `TypeError: Failed to fetch`, with nothing in the error to tell them apart (Chrome 152,
 * 2026-09-14). A second request with `mode: 'no-cors'` does tell them apart: it resolves
 * with an opaque response whenever the server answered at all, and rejects when nothing
 * did. Measured: LM Studio with CORS off and NVIDIA resolved; a closed port and an
 * unresolvable host rejected.
 *
 * - `answered`: the page can read the response. `status` may still be 401 or 404.
 * - `cors-blocked`: the server answered and the browser would not let the page read it.
 * - `unreachable`: nothing answered — not running, wrong host or port, or offline.
 * - `timeout`: no answer inside `timeoutMs` (an unroutable LAN address hangs, not fails).
 * - `browser-asking` / `browser-blocked`: a public page called this computer or the LAN, and the
 *   browser is still asking the person, or was told no (ADR-64, `local-network.ts`). Without
 *   asking the permission these read as `timeout` and `unreachable`.
 */
export type EndpointProbe =
  | { readonly kind: 'answered'; readonly status: number }
  | { readonly kind: 'cors-blocked' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'browser-asking'; readonly space: 'loopback' | 'local' }
  | { readonly kind: 'browser-blocked'; readonly space: 'loopback' | 'local' };

export interface ProbeOptions {
  /** Defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
  /** Sent on the readable request only; a `no-cors` request drops non-safelisted headers. */
  readonly headers?: Record<string, string>;
  /** Per request. Defaults to 5000 ms. */
  readonly timeoutMs?: number;
  /** The page's origin and the browser's permissions, for a failure the browser caused.
   * Defaults to `location.origin` and `navigator.permissions`; null skips the question. */
  readonly localNetwork?: { readonly pageOrigin: string; readonly permissions: PermissionsLike | null } | null;
}

function defaultLocalNetwork(): ProbeOptions['localNetwork'] {
  const pageOrigin = globalThis.location?.origin;
  if (typeof pageOrigin !== 'string') return null;
  return { pageOrigin, permissions: (globalThis.navigator?.permissions as PermissionsLike | undefined) ?? null };
}

/** `browser-asking` or `browser-blocked` when the browser, not the server, is why `url` failed. */
async function browserVerdict(url: string, options: ProbeOptions): Promise<EndpointProbe | null> {
  const local = options.localNetwork === undefined ? defaultLocalNetwork() : options.localNetwork;
  if (local === null || local === undefined) return null;
  const space = localNetworkNeeded(local.pageOrigin, url);
  if (space === null) return null;
  const state = await localNetworkPermission(space, local.permissions);
  if (state === 'prompt') return { kind: 'browser-asking', space };
  if (state === 'denied') return { kind: 'browser-blocked', space };
  return null;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** GET `url` and classify the outcome. Never throws. */
export async function probeEndpoint(url: string, options: ProbeOptions = {}): Promise<EndpointProbe> {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  try {
    const response = await fetchFn(url, {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { kind: 'answered', status: response.status };
  } catch (error) {
    const verdict = await browserVerdict(url, options);
    if (verdict !== null) return verdict;
    if (isTimeout(error)) return { kind: 'timeout' };
  }
  try {
    await fetchFn(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return { kind: 'cors-blocked' };
  } catch (error) {
    return isTimeout(error) ? { kind: 'timeout' } : { kind: 'unreachable' };
  }
}
