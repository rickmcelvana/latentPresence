import type { HttpFetch } from '../llm/discovery';

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
 */
export type EndpointProbe =
  | { readonly kind: 'answered'; readonly status: number }
  | { readonly kind: 'cors-blocked' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'timeout' };

export interface ProbeOptions {
  /** Defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
  /** Sent on the readable request only; a `no-cors` request drops non-safelisted headers. */
  readonly headers?: Record<string, string>;
  /** Per request. Defaults to 5000 ms. */
  readonly timeoutMs?: number;
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
    if (isTimeout(error)) return { kind: 'timeout' };
  }
  try {
    await fetchFn(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return { kind: 'cors-blocked' };
  } catch (error) {
    return isTimeout(error) ? { kind: 'timeout' } : { kind: 'unreachable' };
  }
}
