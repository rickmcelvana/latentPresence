import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPANION_TOKEN_HEADER, desktopFetch, desktopShell, initDesktop, resetDesktopForTests, type Invoke } from './desktop';
import { KEYCHAIN_INDEX_KEY, KeychainVault } from './keychain-vault';

afterEach(resetDesktopForTests);

const companion = { companionUrl: 'http://127.0.0.1:8790', token: 'tok' };

/** A fetch that records what it was asked and answers 200. */
function recording() {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), headers: new Headers(init?.headers) });
    return new Response('{}');
  });
  return { fetch, calls };
}

describe('desktopFetch (P8-T01, ADR-60)', () => {
  it('adds the pairing token to every request to the companion, and to nothing else', async () => {
    const { fetch, calls } = recording();
    const wrapped = desktopFetch(fetch, companion);
    await wrapped('http://127.0.0.1:8790/health');
    await wrapped('http://127.0.0.1:8790/db/facts', { method: 'POST', headers: { 'content-type': 'application/json' } });
    await wrapped('https://huggingface.co/onnx-community/x/resolve/main/config.json');
    await wrapped('http://127.0.0.1:8787/health');

    expect(calls.map((call) => [call.url, call.headers.get(COMPANION_TOKEN_HEADER)])).toEqual([
      ['http://127.0.0.1:8790/health', 'tok'],
      ['http://127.0.0.1:8790/db/facts', 'tok'],
      ['https://huggingface.co/onnx-community/x/resolve/main/config.json', null],
      ['http://127.0.0.1:8787/health', null],
    ]);
    expect(calls[1]?.headers.get('content-type')).toBe('application/json');
  });

  it("sends this machine's Ollama and LM Studio through the companion's relay, keeping the key", async () => {
    const { fetch, calls } = recording();
    const wrapped = desktopFetch(fetch, companion);
    await wrapped('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k' } });
    await wrapped(new URL('http://localhost:11434/api/tags'));
    await wrapped('http://localhost:1234/v1/models');

    expect(calls.map((call) => [call.url, call.headers.get('x-lp-target'), call.headers.get(COMPANION_TOKEN_HEADER)])).toEqual([
      ['http://127.0.0.1:8790/relay', 'http://127.0.0.1:11434/v1/chat/completions', 'tok'],
      ['http://127.0.0.1:8790/relay', 'http://localhost:11434/api/tags', 'tok'],
      ['http://127.0.0.1:8790/relay', 'http://localhost:1234/v1/models', 'tok'],
    ]);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer k');
  });

  it('leaves a model server on the LAN, or on another local port, to be called directly', async () => {
    const { fetch, calls } = recording();
    const wrapped = desktopFetch(fetch, companion);
    await wrapped('http://192.168.1.20:11434/v1/models');
    await wrapped('http://127.0.0.1:8080/v1/models');
    expect(calls.map((call) => call.url)).toEqual(['http://192.168.1.20:11434/v1/models', 'http://127.0.0.1:8080/v1/models']);
  });
});

describe('initDesktop', () => {
  it('is nothing in a browser', async () => {
    const scope = { fetch: vi.fn() as unknown as typeof fetch };
    expect(await initDesktop(scope)).toBeNull();
    expect(desktopShell()).toBeNull();
  });

  it('asks the shell for its companion and wraps fetch', async () => {
    const { fetch, calls } = recording();
    const invoke = vi.fn(async () => ({ url: companion.companionUrl, token: companion.token })) as unknown as Invoke;
    const scope = { __TAURI__: { core: { invoke } }, fetch: fetch as unknown as typeof globalThis.fetch };
    expect((await initDesktop(scope))?.companionUrl).toBe('http://127.0.0.1:8790');
    expect(desktopShell()?.token).toBe('tok');

    await scope.fetch('http://127.0.0.1:8790/health');
    expect(calls[0]?.headers.get(COMPANION_TOKEN_HEADER)).toBe('tok');
  });

  it('runs as in a browser when the shell does not answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invoke = vi.fn(async () => Promise.reject(new Error('no such command'))) as unknown as Invoke;
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const scope = { __TAURI__: { core: { invoke } }, fetch };
    expect(await initDesktop(scope)).toBeNull();
    expect(scope.fetch).toBe(fetch);
  });
});

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

/** The shell's `secret_*` commands over a map, as Credential Manager would hold them. */
function fakeKeychain() {
  const secrets = new Map<string, string>();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const name = String(args?.['name']);
    if (command === 'secret_set') secrets.set(name, String(args?.['value']));
    if (command === 'secret_get') return secrets.get(name) ?? null;
    if (command === 'secret_delete') secrets.delete(name);
    return null;
  }) as unknown as Invoke;
  return { secrets, invoke };
}

describe('KeychainVault (P8-T01)', () => {
  it('keeps the secret in the OS and only the ref in the page', async () => {
    const { secrets, invoke } = fakeKeychain();
    const storage = memoryStorage();
    const vault = new KeychainVault(invoke, storage);
    await vault.saveKey('llm:openai', 'sk-123');

    expect(secrets.get('llm:openai')).toBe('sk-123');
    expect(storage.getItem(KEYCHAIN_INDEX_KEY)).toBe('["llm:openai"]');
    expect(vault.hasKey('llm:openai')).toBe(true);
    expect(await vault.loadKey('llm:openai')).toBe('sk-123');
    expect(await vault.loadKey('tts')).toBeNull();
  });

  it('forgets in the OS too, and drops a ref the OS no longer has', async () => {
    const { secrets, invoke } = fakeKeychain();
    const vault = new KeychainVault(invoke, memoryStorage());
    await vault.saveKey('llm:openai', 'sk-123');
    await vault.saveKey('tts', 't');
    vault.forgetKey('llm:openai');
    await Promise.resolve();
    expect(vault.hasKey('llm:openai')).toBe(false);
    expect(secrets.has('llm:openai')).toBe(false);

    secrets.delete('tts');
    expect(await vault.loadKey('tts')).toBeNull();
    expect(vault.hasKey('tts')).toBe(false);
  });

  it('forgets everything', async () => {
    const { secrets, invoke } = fakeKeychain();
    const vault = new KeychainVault(invoke, memoryStorage());
    await vault.saveKey('a', '1');
    await vault.saveKey('b', '2');
    vault.forgetAll();
    await Promise.resolve();
    expect(vault.hasKey('a') || vault.hasKey('b')).toBe(false);
    expect(secrets.size).toBe(0);
  });
});
