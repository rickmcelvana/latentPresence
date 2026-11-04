import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrityProblem, sha256Hex } from './integrity';
import { PINS } from './pins';
import { installPinnedFetch, pinnedFetch, verifiedResponse, verifyCachedFiles, type VerifiableCaches } from './pinned-fetch';

const REPO = 'onnx-community/silero-vad';
const FILE = 'onnx/model.onnx';
const REVISION = PINS[REPO]?.revision ?? '';
const ORIGIN = 'https://app.example';

function hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const GOOD = new Uint8Array([1, 2, 3, 4]);
const PIN = { bytes: GOOD.length, sha256: hex(GOOD) };

function stubNative(respond: (url: string) => Response): { native: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const native = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return respond(url);
  }) as typeof fetch;
  return { native, urls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('integrityProblem', () => {
  it('passes the pinned bytes', async () => {
    expect(await integrityProblem(GOOD, PIN, 'x')).toBeNull();
    expect(await sha256Hex(GOOD)).toBe(PIN.sha256);
  });

  it('names a wrong size in the words the consent screen would use', async () => {
    expect(await integrityProblem(new Uint8Array(3), PIN, 'Silero')).toBe('Silero: downloaded 3 bytes, catalog says 4');
  });

  it('refuses bytes of the right size and the wrong content', async () => {
    expect(await integrityProblem(new Uint8Array([4, 3, 2, 1]), PIN, 'Silero')).toMatch(/not the bytes this app pinned/u);
  });

  it('falls back to the size where the context has no crypto.subtle', async () => {
    vi.stubGlobal('crypto', {});
    expect(await sha256Hex(GOOD)).toBeNull();
    expect(await integrityProblem(new Uint8Array([4, 3, 2, 1]), PIN, 'x')).toBeNull();
    expect(await integrityProblem(new Uint8Array(3), PIN, 'x')).toMatch(/downloaded 3 bytes/u);
  });
});

describe('verifiedResponse', () => {
  it('passes the body through and keeps the status and headers a progress bar reads', async () => {
    const response = verifiedResponse(new Response(GOOD, { status: 200, headers: { 'content-length': '4' } }), PIN, 'x');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(GOOD);
  });

  it('checks across chunks, handing each on as it arrives', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(GOOD.slice(0, 2));
        controller.enqueue(GOOD.slice(2));
        controller.close();
      },
    });
    const reader = (verifiedResponse(new Response(body), PIN, 'x').body as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).value).toEqual(GOOD.slice(0, 2));
    expect((await reader.read()).value).toEqual(GOOD.slice(2));
    expect((await reader.read()).done).toBe(true);
  });

  it('ends a wrong body in an error, so a reader never gets to store it', async () => {
    const response = verifiedResponse(new Response(new Uint8Array([9, 9, 9, 9])), PIN, 'Silero');
    await expect(response.arrayBuffer()).rejects.toThrow(/not the bytes this app pinned/u);
  });
});

describe('pinnedFetch', () => {
  it('moves a request for main to the pinned commit', async () => {
    const pinned = PINS[REPO]?.files[FILE];
    const { native, urls } = stubNative(() => new Response(new Uint8Array(0)));
    const guarded = pinnedFetch(native, [REPO], ORIGIN);
    const response = await guarded(`https://huggingface.co/${REPO}/resolve/main/${FILE}`);
    expect(urls).toEqual([`https://huggingface.co/${REPO}/resolve/${REVISION}/${FILE}`]);
    // The stub's empty body is not the 2.2 MB pinned, and reading it says so.
    expect(pinned?.bytes).toBeGreaterThan(0);
    await expect(response.arrayBuffer()).rejects.toThrow(/downloaded 0 bytes/u);
  });

  it('answers a file not in the table with a 404 and no request', async () => {
    const { native, urls } = stubNative(() => new Response('never'));
    const response = await pinnedFetch(native, [REPO], ORIGIN)(`https://huggingface.co/${REPO}/resolve/main/processor_config.json`);
    expect(response.status).toBe(404);
    expect(urls).toEqual([]);
  });

  it('refuses a repository this worker has no pin for', async () => {
    const { native, urls } = stubNative(() => new Response('never'));
    await expect(pinnedFetch(native, [REPO], ORIGIN)('https://huggingface.co/someone/else/resolve/main/model.onnx')).rejects.toThrow(/no pin/u);
    // In the table, but not this worker's.
    await expect(pinnedFetch(native, [], ORIGIN)(`https://huggingface.co/${REPO}/resolve/main/${FILE}`)).rejects.toThrow(/no pin/u);
    expect(urls).toEqual([]);
  });

  it('refuses any other host, jsDelivr above all', async () => {
    const { native, urls } = stubNative(() => new Response('never'));
    const guarded = pinnedFetch(native, [REPO], ORIGIN);
    await expect(guarded('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.wasm')).rejects.toThrow(/refused/u);
    await expect(guarded('https://odml.pa.googleapis.com/v1/log')).rejects.toThrow(/refused/u);
    expect(urls).toEqual([]);
  });

  it("lets the app's own files through untouched", async () => {
    const { native, urls } = stubNative(() => new Response(new Uint8Array([7])));
    const guarded = pinnedFetch(native, [REPO], ORIGIN);
    for (const url of [`${ORIGIN}/assets/ort.wasm`, '/assets/ort.wasm', 'data:application/octet-stream;base64,AA==', `blob:${ORIGIN}/abc`]) {
      expect(new Uint8Array(await (await guarded(url)).arrayBuffer())).toEqual(new Uint8Array([7]));
    }
    expect(urls).toHaveLength(4);
  });

  it('hands back a failure from the host as it is, for the library to report', async () => {
    const { native } = stubNative(() => new Response('gone', { status: 503 }));
    const response = await pinnedFetch(native, [REPO], ORIGIN)(`https://huggingface.co/${REPO}/resolve/main/${FILE}`);
    expect(response.status).toBe(503);
  });

  it('reads the address out of a Request as well as a string', async () => {
    const { native, urls } = stubNative(() => new Response(new Uint8Array(0)));
    await pinnedFetch(native, [REPO], ORIGIN)(new Request(`https://huggingface.co/${REPO}/resolve/main/${FILE}`));
    expect(urls[0]).toContain(REVISION);
  });
});

describe('installPinnedFetch', () => {
  it("replaces the scope's fetch, as the libraries read it at call time", async () => {
    const original = vi.fn(async () => new Response('own'));
    const scope = { fetch: original as typeof fetch, location: { origin: ORIGIN } as WorkerLocation };
    installPinnedFetch(scope, [REPO]);
    expect(scope.fetch).not.toBe(original);
    await expect(scope.fetch('https://example.com/x')).rejects.toThrow(/refused/u);
    expect(await (await scope.fetch(`${ORIGIN}/y`)).text()).toBe('own');
  });
});

function cachesHolding(entries: Record<string, Uint8Array<ArrayBuffer>>): { caches: VerifiableCaches; deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    caches: {
      open: async () => ({
        match: async (url: string) => (entries[url] === undefined ? undefined : new Response(entries[url])),
        delete: async (url: string) => {
          deleted.push(url);
          return true;
        },
      }),
    },
  };
}

describe('verifyCachedFiles', () => {
  const MAIN_URL = `https://huggingface.co/${REPO}/resolve/main/${FILE}`;

  it('removes a cached file that is not what was pinned, under the key the library wrote', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { caches, deleted } = cachesHolding({ [MAIN_URL]: new Uint8Array([1]) });
    expect(await verifyCachedFiles('transformers-cache', REPO, [FILE], caches)).toBe(1);
    expect(deleted).toEqual([MAIN_URL]);
  });

  it('leaves alone what it holds no pin for, and what is not cached', async () => {
    const { caches, deleted } = cachesHolding({ [`https://huggingface.co/${REPO}/resolve/main/other`]: new Uint8Array([1]) });
    expect(await verifyCachedFiles('c', REPO, [FILE, 'other'], caches)).toBe(0);
    expect(deleted).toEqual([]);
    expect(await verifyCachedFiles('c', 'nobody/nothing', [FILE], caches)).toBe(0);
  });

  it('does nothing where the cache cannot be opened: the private window', async () => {
    const caches: VerifiableCaches = { open: () => Promise.reject(new Error('denied')) };
    expect(await verifyCachedFiles('c', REPO, [FILE], caches)).toBe(0);
  });
});
