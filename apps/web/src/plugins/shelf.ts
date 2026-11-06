import type { PluginOrigin } from './sources';

/**
 * The installed plugins (P10-T03, ADR-72 item 8): kept in this browser's IndexedDB, in the desktop
 * app too (its webview's storage lives in the app's data folder, so no file of our own is needed).
 * A plugin's description and its folder's files are separate stores, so listing never reads a deck
 * of pictures. What is kept is what was checked and agreed to; it is checked again whenever it is
 * loaded, so a stored plugin that no longer passes is refused rather than run.
 */
export interface InstalledPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly origin: PluginOrigin;
  readonly installedAt: string;
}

export interface StoredPlugin {
  readonly manifestText: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface PluginShelf {
  /** By name. */
  list(): Promise<readonly InstalledPlugin[]>;
  /** Replaces a plugin with the same id (an update). */
  put(plugin: InstalledPlugin, stored: StoredPlugin): Promise<void>;
  /** Null when it is not installed. */
  read(id: string): Promise<StoredPlugin | null>;
  remove(id: string): Promise<void>;
}

export class InMemoryPluginShelf implements PluginShelf {
  private readonly plugins = new Map<string, { plugin: InstalledPlugin; stored: StoredPlugin }>();

  async list(): Promise<readonly InstalledPlugin[]> {
    return [...this.plugins.values()].map((entry) => entry.plugin).toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async put(plugin: InstalledPlugin, stored: StoredPlugin): Promise<void> {
    this.plugins.set(plugin.id, { plugin, stored: { manifestText: stored.manifestText, files: new Map(stored.files) } });
  }

  async read(id: string): Promise<StoredPlugin | null> {
    return this.plugins.get(id)?.stored ?? null;
  }

  async remove(id: string): Promise<void> {
    this.plugins.delete(id);
  }
}

const DB_NAME = 'latentpresence-plugins';
const PLUGINS = 'plugins';
const FILES = 'files';

interface StoredFiles {
  readonly manifestText: string;
  readonly files: readonly (readonly [string, ArrayBuffer])[];
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')));
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('IndexedDB transaction failed')));
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')));
  });
}

/** The real shelf. Tests pass `fake-indexeddb`'s `IDBFactory`. */
export class IndexedDbPluginShelf implements PluginShelf {
  private readonly factory: IDBFactory;
  private db: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory = globalThis.indexedDB) {
    this.factory = factory;
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, 1);
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore(PLUGINS, { keyPath: 'id' });
        request.result.createObjectStore(FILES);
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB would not open')));
    });
    return this.db;
  }

  async list(): Promise<readonly InstalledPlugin[]> {
    const db = await this.open();
    const plugins = (await done(db.transaction(PLUGINS).objectStore(PLUGINS).getAll())) as InstalledPlugin[];
    return plugins.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async put(plugin: InstalledPlugin, stored: StoredPlugin): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([PLUGINS, FILES], 'readwrite');
    transaction.objectStore(PLUGINS).put(plugin);
    // Copies of exactly these bytes: a view may sit on a larger buffer (a whole zip).
    const files: StoredFiles = { manifestText: stored.manifestText, files: [...stored.files].map(([path, bytes]) => [path, bytes.slice().buffer]) };
    transaction.objectStore(FILES).put(files, plugin.id);
    await committed(transaction);
  }

  async read(id: string): Promise<StoredPlugin | null> {
    const db = await this.open();
    const stored = (await done(db.transaction(FILES).objectStore(FILES).get(id))) as StoredFiles | undefined;
    if (stored === undefined) return null;
    return { manifestText: stored.manifestText, files: new Map(stored.files.map(([path, buffer]) => [path, new Uint8Array(buffer)])) };
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([PLUGINS, FILES], 'readwrite');
    transaction.objectStore(PLUGINS).delete(id);
    transaction.objectStore(FILES).delete(id);
    await committed(transaction);
  }
}

let shared: PluginShelf | null = null;

/** The page's shelf: this browser's IndexedDB, or one that lasts the visit where there is none. */
export function defaultPluginShelf(): PluginShelf {
  shared ??= typeof globalThis.indexedDB === 'undefined' ? new InMemoryPluginShelf() : new IndexedDbPluginShelf();
  return shared;
}
