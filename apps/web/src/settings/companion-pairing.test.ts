import { describe, expect, it } from 'vitest';
import { COMPANION_TOKEN_HEADER } from '../desktop/desktop';
import { initCompanionPairing, loadPairingCode, normalisePairingCode, pairingFetch, PAIRING_STORAGE_KEY, savePairingCode } from './companion-pairing';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from './settings';

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('the companion pairing code in a browser (P8-T03, ADR-64)', () => {
  it('keeps the code as the companion compares it, and forgets it', () => {
    const storage = memoryStorage();
    expect(loadPairingCode(storage)).toBeNull();
    savePairingCode(storage, ' abcd-efgh 2345-6723 ');
    expect(loadPairingCode(storage)).toBe('ABCDEFGH23456723');
    expect(normalisePairingCode('k7qm-2xpa')).toBe('K7QM2XPA');
    savePairingCode(storage, '---');
    expect(loadPairingCode(storage)).toBeNull();
    savePairingCode(storage, 'ABCD');
    savePairingCode(storage, null);
    expect(storage.getItem(PAIRING_STORAGE_KEY)).toBeNull();
  });

  it('adds the code to requests to the companion only, and nothing without a code', async () => {
    const seen: [string, Headers][] = [];
    const base = async (input: string | URL, init?: RequestInit) => {
      seen.push([String(input), new Headers(init?.headers)]);
      return new Response('ok');
    };
    let code: string | null = 'ABCD';
    let companionUrl = 'http://127.0.0.1:8787';
    const fetch = pairingFetch(base, { companionUrl: () => companionUrl, code: () => code });

    await fetch('http://127.0.0.1:8787/health', { headers: { accept: 'application/json' } });
    await fetch('http://127.0.0.1:11434/api/tags');
    await fetch('https://api.deepseek.com/v1/models');
    companionUrl = 'http://127.0.0.1:9000/';
    await fetch('http://127.0.0.1:9000/memory/blocks');
    code = null;
    await fetch('http://127.0.0.1:9000/health');

    expect(seen.map(([url, headers]) => [url, headers.get(COMPANION_TOKEN_HEADER)])).toEqual([
      ['http://127.0.0.1:8787/health', 'ABCD'],
      ['http://127.0.0.1:11434/api/tags', null],
      ['https://api.deepseek.com/v1/models', null],
      ['http://127.0.0.1:9000/memory/blocks', 'ABCD'],
      ['http://127.0.0.1:9000/health', null],
    ]);
    expect(seen[0]?.[1].get('accept')).toBe('application/json');
  });

  it('wraps a scope\'s fetch once, reading the address and the code from its storage', async () => {
    const storage = memoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, companionUrl: 'http://127.0.0.1:8790' }));
    savePairingCode(storage, 'WXYZ');
    const calls: Headers[] = [];
    const scope = {
      localStorage: storage,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Headers(init?.headers));
        return new Response('ok');
      }) as typeof fetch,
    };
    initCompanionPairing(scope);
    await scope.fetch('http://127.0.0.1:8790/health');
    await scope.fetch('http://127.0.0.1:8787/health');
    expect(calls.map((headers) => headers.get(COMPANION_TOKEN_HEADER))).toEqual(['WXYZ', null]);
  });
});
