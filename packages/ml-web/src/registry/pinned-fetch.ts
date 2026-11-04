import { integrityProblem } from './integrity';
import { PINS, type PinnedFile } from './pins';

/**
 * Pinning for the downloads whose `fetch` we do not make ourselves (P9-T05, ADR-70).
 *
 * transformers.js and kokoro-js fetch from inside the library. kokoro-js's `from_pretrained`
 * takes no revision, and it builds its voices' `resolve/main` address itself, so a `revision`
 * option could never cover them, and neither library checks a hash. What they all go through is
 * the worker's global `fetch`, read at call time, so that is the seam: `face.worker.ts` already
 * guards it the same way. Nothing here can reach a page: these run only in a model's worker.
 *
 * - **A request for a pinned repository goes to the pinned commit**, whatever ref it named.
 * - **Its body is checked as it passes**, so transformers.js keeps its progress reporting. A body
 *   that is wrong ends in an error instead of an end: the library's read rejects before it
 *   reaches `cache.put`, and bad bytes are never stored.
 * - **A file not in the table is a 404 with no request.** transformers.js asks for optional files
 *   and takes a 404 as "not there"; a required one fails the load, loudly.
 * - **Any other address is refused**, but for the app's own files.
 *
 * The cache keys stay what they always were (`resolve/main/...`, from the library), so an
 * installed copy keeps what it has; `verifyCachedFiles` is what checks those.
 */

const HUB_FILE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/u;

function isOwn(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url, origin);
    return parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.origin === origin;
  } catch {
    return false;
  }
}

/** `response`, with its body checked against `file` as it passes through. */
export function verifiedResponse(response: Response, file: PinnedFile, label: string): Response {
  if (response.body === null) return response;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const checked = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        chunks.push(chunk);
        length += chunk.length;
        controller.enqueue(chunk);
      },
      async flush() {
        const whole = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          whole.set(chunk, offset);
          offset += chunk.length;
        }
        chunks.length = 0;
        const problem = await integrityProblem(whole, file, label);
        // Thrown from `flush`, this errors the readable side: the reader sees a rejection.
        if (problem !== null) throw new Error(problem);
      },
    }),
  );
  return new Response(checked, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** A `fetch` for a worker that may reach only `sources` (keys of `PINS`) and its own origin. */
export function pinnedFetch(native: typeof fetch, sources: readonly string[], origin: string): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const hub = HUB_FILE.exec(url);
    if (hub === null) {
      if (isOwn(url, origin)) return native(input, init);
      throw new Error(`refused a request to ${url}: it is not in the model registry`);
    }
    const [, key = '', path = ''] = hub;
    const source = sources.includes(key) ? PINS[key] : undefined;
    if (source === undefined) throw new Error(`refused a request to ${url}: this worker has no pin for ${key}`);
    const file = source.files[path];
    if (file === undefined) return new Response(null, { status: 404, statusText: 'not in the model registry' });
    const response = await native(`${source.base}${path}`, init);
    return response.ok ? verifiedResponse(response, file, `${key}/${path}`) : response;
  };
}

/** Puts the guard on this worker's `fetch`. Called at the top of the worker, before any load. */
export function installPinnedFetch(scope: Pick<WorkerGlobalScope, 'fetch' | 'location'>, sources: readonly string[]): void {
  scope.fetch = pinnedFetch(scope.fetch.bind(scope), sources, scope.location.origin);
}

/** The slice of Cache Storage `verifyCachedFiles` needs, so a test can hand over a fake. */
export interface VerifiableCaches {
  open(name: string): Promise<{
    match(request: string): Promise<Response | undefined>;
    delete(request: string): Promise<boolean>;
  }>;
}

/**
 * Removes any of these files the cache holds that are not what was pinned, so the library fetches
 * the right ones (through the guard above). A person who downloaded before the pins existed took
 * `main` on trust; that entry was never checked, so it is checked here, on every load, at a cost
 * measured in `docs/SURFACE.md`. A cache that cannot be read is a private window: nothing to do.
 *
 * Keys are the libraries' own: `https://huggingface.co/<repo>/resolve/main/<path>`.
 */
export async function verifyCachedFiles(cacheName: string, key: string, paths: readonly string[], caches: VerifiableCaches | undefined = globalThis.caches): Promise<number> {
  const source = PINS[key];
  if (source === undefined || caches === undefined) return 0;
  let removed = 0;
  try {
    const cache = await caches.open(cacheName);
    for (const path of paths) {
      const file = source.files[path];
      const url = `https://huggingface.co/${key}/resolve/main/${path}`;
      const cached = await cache.match(url);
      if (cached === undefined || file === undefined) continue;
      const problem = await integrityProblem(new Uint8Array(await cached.arrayBuffer()), file, `${key}/${path}`);
      if (problem === null) continue;
      console.warn(`Removed a cached file: ${problem}`);
      await cache.delete(url);
      removed += 1;
    }
  } catch {
    return removed;
  }
  return removed;
}
