import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMasterKeyPort, Vault } from './vault';

/** A `Pick<Storage, ...>` backed by a plain `Map`, returned alongside the storage object
 * so plaintext-leak assertions can read it directly rather than through jsdom's real
 * `localStorage` (which these tests never touch). */
function memoryStorage(): { storage: Storage; backing: Map<string, string> } {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
    clear: () => backing.clear(),
    key: () => null,
    get length() {
      return backing.size;
    },
  } as Storage;
  return { storage, backing };
}

let storage: Storage;
let backing: Map<string, string>;
let vault: Vault;

beforeEach(() => {
  ({ storage, backing } = memoryStorage());
  vault = new Vault(new InMemoryMasterKeyPort(), storage);
});

describe('Vault', () => {
  it('round-trips a saved secret', async () => {
    await vault.saveKey('llm:nvidia', 'nvapi-secret-value');
    expect(await vault.loadKey('llm:nvidia')).toBe('nvapi-secret-value');
  });

  it('reports whether a ref has something saved, without decrypting', async () => {
    expect(vault.hasKey('tts')).toBe(false);
    await vault.saveKey('tts', 'k');
    expect(vault.hasKey('tts')).toBe(true);
  });

  it('returns null for a ref nothing was saved under', async () => {
    expect(await vault.loadKey('stt')).toBeNull();
  });

  it('gives two saves of the same secret different ciphertext (a fresh IV every write)', async () => {
    await vault.saveKey('tts', 'same-secret');
    const first = backing.get('latentpresence.keys.v1');
    await vault.saveKey('tts', 'same-secret');
    const second = backing.get('latentpresence.keys.v1');
    expect(first).not.toBe(second);
    // Still decrypts to the same thing on the far side of two different ciphertexts.
    expect(await vault.loadKey('tts')).toBe('same-secret');
  });

  it('forgetKey removes one ref and leaves the others', async () => {
    await vault.saveKey('tts', 'a');
    await vault.saveKey('stt', 'b');
    vault.forgetKey('tts');
    expect(vault.hasKey('tts')).toBe(false);
    expect(await vault.loadKey('stt')).toBe('b');
  });

  it('forgetAll clears every saved key', async () => {
    await vault.saveKey('tts', 'a');
    await vault.saveKey('stt', 'b');
    vault.forgetAll();
    expect(vault.hasKey('tts')).toBe(false);
    expect(vault.hasKey('stt')).toBe(false);
  });

  it('loadKey returns null and drops the entry when the master key is lost', async () => {
    await vault.saveKey('llm:nvidia', 'secret');
    // IndexedDB cleared, localStorage kept: a fresh port with the same storage.
    const afterReset = new Vault(new InMemoryMasterKeyPort(), storage);
    expect(await afterReset.loadKey('llm:nvidia')).toBeNull();
    expect(afterReset.hasKey('llm:nvidia')).toBe(false);
  });

  it('keeps a saved key when the master key store fails, rather than calling it unreadable', async () => {
    const inner = new InMemoryMasterKeyPort();
    await new Vault(inner, storage).saveKey('llm:nvidia', 'secret');
    let failing = true;
    const flaky = new Vault(
      {
        getMaster: () => (failing ? Promise.reject(new Error('IndexedDB unavailable')) : inner.getMaster()),
        putMaster: (key) => inner.putMaster(key),
      },
      storage,
    );
    await expect(flaky.loadKey('llm:nvidia')).rejects.toThrow('IndexedDB unavailable');
    expect(flaky.hasKey('llm:nvidia')).toBe(true);
    failing = false;
    expect(await flaky.loadKey('llm:nvidia')).toBe('secret');
  });

  it('creates one master key when first-time saves race, so every saved key stays readable', async () => {
    let created = 0;
    const inner = new InMemoryMasterKeyPort();
    const slow = new Vault(
      {
        getMaster: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return inner.getMaster();
        },
        putMaster: async (key) => {
          created += 1;
          await inner.putMaster(key);
        },
      },
      storage,
    );
    await Promise.all([slow.saveKey('tts', 'a'), slow.saveKey('stt', 'b')]);
    expect(created).toBe(1);
    const reopened = new Vault(inner, storage);
    expect(await reopened.loadKey('tts')).toBe('a');
    expect(await reopened.loadKey('stt')).toBe('b');
  });

  it('never writes the secret in plain text to storage', async () => {
    await vault.saveKey('llm:nvidia', 'nvapi-do-not-leak-this');
    const raw = backing.get('latentpresence.keys.v1') ?? '';
    expect(raw).not.toContain('nvapi-do-not-leak-this');
  });
});
