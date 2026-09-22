import { ModelConsent } from '@latentpresence/ml-web/consent';

/**
 * The DOM-touching half of consent (P1-T13), kept out of `packages/ml-web` — that package
 * has no DOM in it at all — and out of `@latentpresence/ml-web/consent`'s safe subpath,
 * which stays free of anything that would need a `window` to construct.
 */

/** A fresh `ModelConsent` over this browser's `localStorage`. A function, not a top-level
 * singleton, so importing this module touches no DOM until something calls it — the same
 * shape as `defaultSettingsDeps()` in `apps/web/src/settings/deps.ts`. */
export function defaultModelConsent(): ModelConsent {
  return new ModelConsent(window.localStorage);
}

/** The slice of `Cache` the Downloaded-models section needs, so a test can inject an
 * in-memory fake — jsdom implements no Cache Storage API at all, so there is nothing real
 * to fall back to in a test either way. */
export interface MinimalCache {
  keys(): Promise<readonly Request[]>;
  match(request: Request | string): Promise<Response | undefined>;
}

/** The slice of `CacheStorage` the Downloaded-models section needs. A real `CacheStorage`
 * satisfies this structurally, so `defaultConsentCaches()` below needs no adapter. */
export interface MinimalCacheStorage {
  keys(): Promise<readonly string[]>;
  open(name: string): Promise<MinimalCache>;
  delete(name: string): Promise<boolean>;
}

/** This browser's real Cache Storage. */
export function defaultConsentCaches(): MinimalCacheStorage {
  return window.caches;
}
