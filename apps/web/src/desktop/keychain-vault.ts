import { PendingSaves, type KeyVault } from '../settings/vault';
import type { Invoke } from './desktop';

/**
 * API keys in Windows Credential Manager, for the desktop app (P8-T01, ADR-60).
 *
 * In a browser the vault encrypts with a key IndexedDB holds (P1-T10); in the app the OS keeps
 * the secret itself, behind the person's Windows sign-in, through the shell's `secret_*`
 * commands (the `keyring` crate). What stays in the page is an index of which refs have a key —
 * no secret — so `hasKey` answers at once, as the browser vault's does.
 */
export const KEYCHAIN_INDEX_KEY = 'latentpresence.keychain.v1';

export class KeychainVault implements KeyVault {
  private readonly invoke: Invoke;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private readonly pending = new PendingSaves();

  constructor(invoke: Invoke, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = window.localStorage) {
    this.invoke = invoke;
    this.storage = storage;
  }

  private refs(): Set<string> {
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(KEYCHAIN_INDEX_KEY) ?? '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((ref): ref is string => typeof ref === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private writeRefs(refs: Set<string>): void {
    this.storage.setItem(KEYCHAIN_INDEX_KEY, JSON.stringify([...refs].toSorted()));
  }

  saveKey(ref: string, secret: string): Promise<void> {
    return this.pending.track(ref, this.write(ref, secret));
  }

  private async write(ref: string, secret: string): Promise<void> {
    await this.invoke('secret_set', { name: ref, value: secret });
    const refs = this.refs();
    refs.add(ref);
    this.writeRefs(refs);
  }

  /** The key, or null when there is none — or when the OS no longer has it (removed in
   * Credential Manager by hand), which also drops it from the index. */
  async loadKey(ref: string): Promise<string | null> {
    await this.pending.settled(ref);
    if (!this.refs().has(ref)) return null;
    const secret = await this.invoke<string | null>('secret_get', { name: ref });
    if (secret === null) {
      const refs = this.refs();
      refs.delete(ref);
      this.writeRefs(refs);
    }
    return secret;
  }

  hasKey(ref: string): boolean {
    return this.refs().has(ref);
  }

  forgetKey(ref: string): void {
    const refs = this.refs();
    refs.delete(ref);
    this.writeRefs(refs);
    this.invoke('secret_delete', { name: ref }).catch((error: unknown) => console.warn(`latentPresence: could not remove ${ref} from Credential Manager.`, error));
  }

  forgetAll(): void {
    for (const ref of this.refs()) this.forgetKey(ref);
    this.storage.removeItem(KEYCHAIN_INDEX_KEY);
  }
}
