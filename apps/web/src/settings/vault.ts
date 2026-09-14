/**
 * The key vault (P1-T10).
 *
 * A saved API key never sits in the settings document (`settings.ts`) or anywhere else
 * in plain text. It is encrypted with a non-extractable AES-GCM 256 `CryptoKey` kept in
 * IndexedDB; the ciphertext lives in `localStorage` under `latentpresence.keys.v1`,
 * `{ [ref]: { iv, data } }`, base64, with a fresh 12-byte IV on every write.
 *
 * **What this protects, and what it does not**: it defeats copying `localStorage` out of
 * a browser profile or a backup, because the ciphertext is useless without the
 * non-extractable master key sitting in that same profile's IndexedDB. It does not
 * defend against anything running on the page, or anyone using this browser profile —
 * both can call `loadKey` exactly as this code does. Say that near the key fields, once,
 * in plain words; do not oversell it.
 *
 * IndexedDB access sits behind the two-method `MasterKeyPort` so tests run against an
 * in-memory port with node's `crypto.subtle`, never touching a real IndexedDB. The real
 * adapter (`IndexedDbMasterKeyPort`) is checked in a browser by the architect.
 */

const KEYS_STORAGE_KEY = 'latentpresence.keys.v1';
const AES_ALGORITHM = 'AES-GCM';
const IV_BYTES = 12;

/** The two operations the vault needs on the master key's storage. A real `CryptoKey`
 * survives structured clone into IndexedDB, so the port stores it as-is. */
export interface MasterKeyPort {
  getMaster(): Promise<CryptoKey | null>;
  putMaster(key: CryptoKey): Promise<void>;
}

/** One entry of the ciphertext map kept in `localStorage`. */
interface StoredSecret {
  readonly iv: string;
  readonly data: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isStoredSecret(value: unknown): value is StoredSecret {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['iv'] === 'string' && typeof record['data'] === 'string';
}

/** An in-memory `MasterKeyPort` for tests: no IndexedDB, just a variable held for the
 * life of the port. */
export class InMemoryMasterKeyPort implements MasterKeyPort {
  private master: CryptoKey | null = null;

  async getMaster(): Promise<CryptoKey | null> {
    return this.master;
  }

  async putMaster(key: CryptoKey): Promise<void> {
    this.master = key;
  }
}

const DB_NAME = 'latentpresence-vault';
const STORE_NAME = 'keys';
const MASTER_ID = 'master';

/** The real adapter: one non-extractable `CryptoKey` in IndexedDB, id `master`. Measured
 * working in Chrome 152 across a reload (2026-09-14, `docs/briefs/P1-T10.md`). */
export class IndexedDbMasterKeyPort implements MasterKeyPort {
  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore(STORE_NAME);
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error as Error));
    });
  }

  async getMaster(): Promise<CryptoKey | null> {
    const db = await this.openDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(MASTER_ID);
        request.addEventListener('success', () => resolve((request.result as CryptoKey | undefined) ?? null));
        request.addEventListener('error', () => reject(request.error as Error));
      });
    } finally {
      db.close();
    }
  }

  async putMaster(key: CryptoKey): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(key, MASTER_ID);
        transaction.addEventListener('complete', () => resolve());
        transaction.addEventListener('error', () => reject(transaction.error as Error));
      });
    } finally {
      db.close();
    }
  }
}

/** Encrypted key storage, referenced by a stable ref per slot (`llmKeyRef`, `TTS_KEY_REF`,
 * `STT_KEY_REF` in `settings.ts`). */
export class Vault {
  private readonly port: MasterKeyPort;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

  constructor(port: MasterKeyPort, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = window.localStorage) {
    this.port = port;
    this.storage = storage;
  }

  private master: Promise<CryptoKey> | null = null;

  /** One master key per vault, however many calls race for it. Two first-time saves each
   * generating their own would leave the loser's ciphertext unreadable forever. A failure
   * is not remembered, so the next call tries the store again. */
  private getOrCreateMaster(): Promise<CryptoKey> {
    this.master ??= (async () => {
      const existing = await this.port.getMaster();
      if (existing !== null) return existing;
      const key = await crypto.subtle.generateKey({ name: AES_ALGORITHM, length: 256 }, false, ['encrypt', 'decrypt']);
      await this.port.putMaster(key);
      return key;
    })().catch((error: unknown) => {
      this.master = null;
      throw error;
    });
    return this.master;
  }

  private readAll(): Record<string, StoredSecret> {
    try {
      const raw = this.storage.getItem(KEYS_STORAGE_KEY);
      if (raw === null) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      const result: Record<string, StoredSecret> = {};
      for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isStoredSecret(value)) result[ref] = value;
      }
      return result;
    } catch {
      return {};
    }
  }

  private writeAll(all: Record<string, StoredSecret>): void {
    this.storage.setItem(KEYS_STORAGE_KEY, JSON.stringify(all));
  }

  /** Encrypt and save `secret` under `ref`, replacing anything already there. A fresh IV
   * every call, so saving the same secret twice never produces the same ciphertext. */
  async saveKey(ref: string, secret: string): Promise<void> {
    const master = await this.getOrCreateMaster();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encrypted = await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, master, new TextEncoder().encode(secret));
    const all = this.readAll();
    all[ref] = { iv: toBase64(iv), data: toBase64(new Uint8Array(encrypted)) };
    this.writeAll(all);
  }

  /** Decrypt the key saved under `ref`, or `null` when there is none, or when decryption
   * fails — a master key lost to a cleared IndexedDB while `localStorage` survived. A
   * failed decryption also removes the now-unreadable entry. **A master key that cannot
   * be read at all (IndexedDB failing) throws instead**: that is not proof the entry is
   * unreadable, and deleting on it would lose a good key to a transient error. */
  async loadKey(ref: string): Promise<string | null> {
    const all = this.readAll();
    const entry = all[ref];
    if (entry === undefined) return null;
    const master = await this.getOrCreateMaster();
    try {
      const plain = await crypto.subtle.decrypt(
        { name: AES_ALGORITHM, iv: fromBase64(entry.iv) },
        master,
        fromBase64(entry.data),
      );
      return new TextDecoder().decode(plain);
    } catch {
      delete all[ref];
      this.writeAll(all);
      return null;
    }
  }

  /** Whether a (possibly unreadable) ciphertext is saved under `ref`, with no decryption. */
  hasKey(ref: string): boolean {
    return this.readAll()[ref] !== undefined;
  }

  /** Remove the entry for `ref`, if any. */
  forgetKey(ref: string): void {
    const all = this.readAll();
    delete all[ref];
    this.writeAll(all);
  }

  /** Remove every saved key. */
  forgetAll(): void {
    this.storage.removeItem(KEYS_STORAGE_KEY);
  }
}

/** The vault the app uses outside tests: IndexedDB for the master key, `localStorage`
 * for ciphertext. Constructing it touches neither store until a method is called. */
export const vault = new Vault(new IndexedDbMasterKeyPort());
