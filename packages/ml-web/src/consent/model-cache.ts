import type { ModelDescriptor } from '@latentpresence/protocol';
import { integrityProblem } from '../registry/integrity';

/**
 * Cached fetch for the weights `onnxruntime-web` used to pull straight from a URL (P1-T13).
 *
 * `vad.worker.ts` and `smart-turn.worker.ts` used to hand `InferenceSession.create` a URL
 * and let ort fetch it internally — invisible to us, so it could not be shown on a consent
 * screen first and never landed in transformers.js's `transformers-cache`
 * (`docs/SURFACE.md`, "What actually downloads weights"). This is what they call instead:
 * it puts the fetch back in our hands, in a cache of our own, named separately from
 * transformers.js's so the two never collide.
 *
 * `packages/ml-web/live/turn.ts`'s `modelBytes()` is the same shape — fetch once, verify
 * the byte count against the catalog — with a filesystem cache in place of Cache Storage,
 * because that one runs in node.
 */

export const MODEL_CACHE_NAME = 'latentpresence-models';

/** The slice of `Cache` this needs, so a test can hand over an in-memory fake. */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
}

/** The slice of `CacheStorage` this needs. */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

export interface CachedFetchDeps {
  readonly caches: CacheStorageLike;
  readonly fetch: typeof fetch;
}

/**
 * `caches` is read through `globalThis` and may be missing entirely, which the try/catch
 * below cannot rescue: a bare `caches` reference throws `ReferenceError` while *building*
 * the deps, before any of it runs. **Cache Storage is absent in a non-secure context** —
 * this app is self-hosted, so `http://192.168.x.x` is a real way for a user to reach it —
 * and the incognito case this module is written around is `open()` rejecting, not the API
 * being gone. Without this guard the first is a dead voice rather than an uncached one.
 */
function realDeps(): CachedFetchDeps {
  const storage = (globalThis as { caches?: CacheStorageLike }).caches;
  return {
    caches: storage ?? { open: () => Promise.reject(new Error('Cache Storage is unavailable')) },
    fetch: (input, init) => fetch(input, init),
  };
}

/**
 * `url`'s bytes through `latentpresence-models`, checked against the size and SHA-256 this build
 * pins (ADR-70), whichever way they came. **Only checked bytes are stored**, and a cached entry
 * that fails is dropped and fetched again rather than failing every load from then on.
 *
 * Every Cache Storage call is wrapped and falls back to a plain fetch on any failure —
 * transformers.js does the same for a real reason (private windows, iframes that block storage
 * access), and a hard failure here would mean no voice at all in incognito rather than a slower
 * one every time.
 */
export async function cachedModelFetch(url: string, descriptor: ModelDescriptor, sha256: string, deps: CachedFetchDeps = realDeps()): Promise<Uint8Array> {
  const file = { bytes: descriptor.sizeBytes, sha256 };
  let cache: CacheLike | null = null;
  try {
    cache = await deps.caches.open(MODEL_CACHE_NAME);
  } catch {
    cache = null;
  }

  if (cache !== null) {
    try {
      const cached = await cache.match(url);
      if (cached !== undefined) {
        const bytes = new Uint8Array(await cached.arrayBuffer());
        if ((await integrityProblem(bytes, file, descriptor.label)) === null) return bytes;
        await cache.delete(url);
      }
    } catch {
      // Falls through to a plain fetch below.
    }
  }

  const response = await deps.fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const copy = response.clone();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const problem = await integrityProblem(bytes, file, descriptor.label);
  if (problem !== null) throw new Error(problem);
  if (cache !== null) {
    try {
      await cache.put(url, copy);
    } catch {
      // The bytes are in hand; a cache that cannot be written just means the next call fetches
      // again, which is the private-window case working as intended.
    }
  }
  return bytes;
}
