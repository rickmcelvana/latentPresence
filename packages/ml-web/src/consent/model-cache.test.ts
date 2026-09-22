import type { ModelDescriptor } from '@latentpresence/protocol';
import { describe, expect, it, vi } from 'vitest';
import { cachedModelFetch, MODEL_CACHE_NAME, type CacheLike, type CacheStorageLike } from './model-cache';

const SILERO_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx';

function descriptor(sizeBytes: number): ModelDescriptor {
  return {
    id: 'onnx-community/silero-vad@main:onnx/model.onnx',
    label: 'Silero VAD',
    sizeBytes,
    licence: 'MIT',
    sourceUrl: 'https://huggingface.co/onnx-community/silero-vad',
  };
}

/** A `Cache` backed by a plain `Map`, matching only what `cachedModelFetch` uses. */
function memoryCache(): CacheLike & { readonly stored: Map<string, Uint8Array<ArrayBuffer>> } {
  const stored = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    stored,
    async match(request: string) {
      const bytes = stored.get(request);
      return bytes === undefined ? undefined : new Response(new Blob([bytes]));
    },
    async put(request: string, response: Response) {
      stored.set(request, new Uint8Array(await response.arrayBuffer()));
    },
  };
}

function memoryCacheStorage(cache: CacheLike): CacheStorageLike {
  return { open: async (name: string) => (name === MODEL_CACHE_NAME ? cache : Promise.reject(new Error(`unexpected cache ${name}`))) };
}

function fetchReturning(bytes: Uint8Array<ArrayBuffer>): { fetch: typeof fetch; calls: { count: number } } {
  const calls = { count: 0 };
  const fetchFn = (async () => {
    calls.count += 1;
    return new Response(new Blob([bytes]), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

describe('cachedModelFetch', () => {
  it('a miss fetches and puts the result in the cache', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cache = memoryCache();
    const { fetch: fetchFn, calls } = fetchReturning(bytes);

    const result = await cachedModelFetch(SILERO_URL, descriptor(4), { caches: memoryCacheStorage(cache), fetch: fetchFn });

    expect(result).toEqual(bytes);
    expect(calls.count).toBe(1);
    expect(cache.stored.get(SILERO_URL)).toEqual(bytes);
  });

  it('a hit does not fetch', async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    const cache = memoryCache();
    cache.stored.set(SILERO_URL, bytes);
    const fetchSpy = vi.fn();

    const result = await cachedModelFetch(SILERO_URL, descriptor(3), {
      caches: memoryCacheStorage(cache),
      fetch: fetchSpy as unknown as typeof fetch,
    });

    expect(result).toEqual(bytes);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to a plain fetch when caches.open throws — the private-window case', async () => {
    const bytes = new Uint8Array([9, 9]);
    const { fetch: fetchFn, calls } = fetchReturning(bytes);
    const throwingCaches: CacheStorageLike = {
      open: () => Promise.reject(new Error('SecurityError: storage disabled')),
    };

    const result = await cachedModelFetch(SILERO_URL, descriptor(2), { caches: throwingCaches, fetch: fetchFn });

    expect(result).toEqual(bytes);
    expect(calls.count).toBe(1);
  });

  it('falls back to a plain fetch when cache.match throws', async () => {
    const bytes = new Uint8Array([1]);
    const { fetch: fetchFn, calls } = fetchReturning(bytes);
    const cache: CacheLike = {
      match: () => Promise.reject(new Error('blocked')),
      put: async () => {},
    };

    const result = await cachedModelFetch(SILERO_URL, descriptor(1), { caches: memoryCacheStorage(cache), fetch: fetchFn });

    expect(result).toEqual(bytes);
    expect(calls.count).toBe(1);
  });

  it('still returns the fetched bytes when cache.put throws', async () => {
    const bytes = new Uint8Array([4, 4, 4]);
    const { fetch: fetchFn } = fetchReturning(bytes);
    const cache: CacheLike = {
      match: async () => undefined,
      put: () => Promise.reject(new Error('quota exceeded')),
    };

    const result = await cachedModelFetch(SILERO_URL, descriptor(3), { caches: memoryCacheStorage(cache), fetch: fetchFn });
    expect(result).toEqual(bytes);
  });

  it('throws when the fetched body disagrees with the catalog size', async () => {
    const { fetch: fetchFn } = fetchReturning(new Uint8Array([1, 2, 3]));
    const cache = memoryCache();

    await expect(
      cachedModelFetch(SILERO_URL, descriptor(4), { caches: memoryCacheStorage(cache), fetch: fetchFn }),
    ).rejects.toThrow(/downloaded 3 bytes, catalog says 4/u);
  });

  it('still fetches when Cache Storage is missing entirely, rather than throwing', async () => {
    // A non-secure context (`http://192.168.x.x`, a real way to reach a self-hosted app)
    // has no `caches` at all, and the default deps read that global. A bare reference
    // throws ReferenceError *before* any try/catch runs, so this case is the difference
    // between an uncached voice and no voice. Deps are left out on purpose: the default
    // path is the one under test. Reviewed in, 2026-09-22.
    const { fetch: fetchFn, calls } = fetchReturning(new Uint8Array([1, 2, 3, 4]));
    const host = globalThis as { caches?: unknown };
    const had = 'caches' in host;
    const previous = host.caches;
    delete host.caches;
    vi.stubGlobal('fetch', fetchFn);
    try {
      await expect(cachedModelFetch(SILERO_URL, descriptor(4))).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(calls.count).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      if (had) host.caches = previous;
    }
  });

  it('throws on a non-ok response rather than caching it', async () => {
    const cache = memoryCache();
    const fetchFn = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    await expect(
      cachedModelFetch(SILERO_URL, descriptor(4), { caches: memoryCacheStorage(cache), fetch: fetchFn }),
    ).rejects.toThrow(/HTTP 404/u);
    expect(cache.stored.size).toBe(0);
  });
});
