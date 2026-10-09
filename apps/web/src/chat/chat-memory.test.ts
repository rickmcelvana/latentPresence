import { describe, expect, it } from 'vitest';
import { chooseMemoryStore } from './chat-memory';

// The IndexedDB store opens lazily, so a stand-in factory is enough to be chosen.
const idb = {} as IDBFactory;

function health(connected: boolean): Response {
  return new Response(JSON.stringify({ status: 'ok', service: 'latentpresence-companion', version: '0.0.0', database: { kind: connected ? 'mariadb' : 'none', connected } }), { status: 200 });
}

const missing = async () => Promise.reject(new TypeError('Failed to fetch'));
const slow = (_url: string | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

describe('chooseMemoryStore (P4-T04b)', () => {
  it('remembers nothing when memory is off, and asks nobody', async () => {
    const asked: string[] = [];
    const fetch = async (url: string | URL) => (asked.push(String(url)), health(true));
    expect(await chooseMemoryStore({ setting: 'off', companionUrl: 'http://127.0.0.1:8787', fetch, indexedDB: idb })).toBeNull();
    expect(asked).toEqual([]);
  });

  it('uses the companion on auto when it answers with a connected database', async () => {
    const asked: string[] = [];
    const fetch = async (url: string | URL) => (asked.push(String(url)), health(true));
    const choice = await chooseMemoryStore({ setting: 'auto', companionUrl: 'http://127.0.0.1:8787/', fetch, indexedDB: idb });
    expect(choice?.kind).toBe('companion');
    expect(choice?.store.id).toBe('mariadb');
    expect(asked).toEqual(['http://127.0.0.1:8787/health']);
  });

  it('falls back to this browser on auto when the companion has no database, is missing, or is too slow', async () => {
    const noDatabase = async () => health(false);
    for (const fetch of [noDatabase, missing, slow]) {
      const choice = await chooseMemoryStore({ setting: 'auto', companionUrl: 'http://127.0.0.1:8787', fetch, indexedDB: idb, timeoutMs: 20 });
      expect(choice?.kind).toBe('browser');
      expect(choice?.store.id).toBe('indexeddb');
    }
  });

  it('keeps an explicit companion, warning when it does not answer (R-27) and not when it does', async () => {
    const down = await chooseMemoryStore({ setting: 'companion', companionUrl: 'http://127.0.0.1:8787', fetch: missing, indexedDB: idb, timeoutMs: 20 });
    expect(down?.kind).toBe('companion');
    expect(down?.warning).toContain('pnpm companion');
    const up = await chooseMemoryStore({ setting: 'companion', companionUrl: 'http://127.0.0.1:8787', fetch: async () => health(true), indexedDB: idb });
    expect(up?.warning).toBeUndefined();
  });

  it('takes an explicit choice, and has no browser memory where there is no IndexedDB', async () => {
    const fetch = async () => health(false);
    expect((await chooseMemoryStore({ setting: 'companion', companionUrl: 'http://x', fetch, indexedDB: idb }))?.kind).toBe('companion');
    expect((await chooseMemoryStore({ setting: 'browser', companionUrl: 'http://x', fetch, indexedDB: idb }))?.kind).toBe('browser');
    expect(await chooseMemoryStore({ setting: 'browser', companionUrl: 'http://x', fetch, indexedDB: undefined })).toBeNull();
  });
});
