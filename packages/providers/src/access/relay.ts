import { normaliseBaseUrl, type HttpFetch } from '../llm/discovery';

/** Where the companion listens unless `COMPANION_HOST`/`COMPANION_PORT` moved it. */
export const DEFAULT_COMPANION_URL = 'http://127.0.0.1:8787';

/** The header that names the real URL for the companion's `/relay` (ADR-29). */
export const RELAY_TARGET_HEADER = 'x-lp-target';

/**
 * A fetch that sends every request through the companion's `/relay` instead of straight
 * to its URL (P1-T10, ADR-29) — for endpoints that refuse browser origins (`relay` in
 * `browserAccess`). Hand it to a provider's `fetch` option; the provider does not know.
 *
 * Method, body, headers and the abort signal pass through unchanged, so a barge-in still
 * cancels the upstream call: the companion drops it when the page drops the relay request.
 * The companion forwards only to hosts it allows, and holds no key — the key travels in
 * `Authorization` on each request, as it would have directly.
 */
export function relayFetch(companionUrl: string = DEFAULT_COMPANION_URL, fetchFn?: HttpFetch): HttpFetch {
  const relay = `${normaliseBaseUrl(companionUrl)}/relay`;
  return (input, init) => {
    const target = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    headers.set(RELAY_TARGET_HEADER, target);
    return (fetchFn ?? fetch)(relay, { ...init, headers });
  };
}
