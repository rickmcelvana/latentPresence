/**
 * The person's own bodies (P7-T02, ADR-59): `.vrm` files they picked from disk, kept in this
 * browser's IndexedDB beside the cached models, and never uploaded anywhere — not to the
 * companion, not to us. A body's description and its bytes are separate stores, so listing the
 * shelf never reads forty megabytes of model.
 *
 * Every own body was checked before it was kept (`inspectBody`), so what is stored here is
 * what the picker already showed: its name, its size, and what it cannot show.
 */

export interface OwnBody {
  /** `own:` and a random id; the setting a character's body is saved under. */
  readonly id: string;
  /** The model's own name from its meta, else the file's name without `.vrm`. */
  readonly name: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly addedAt: string;
  readonly authors: readonly string[];
  /** Call presets it lacks (`BodyReport.missing`): it is worn without them. */
  readonly missing: readonly string[];
}

export interface BodyShelf {
  /** Oldest first. */
  list(): Promise<readonly OwnBody[]>;
  add(body: Omit<OwnBody, 'id' | 'addedAt'>, data: Uint8Array): Promise<OwnBody>;
  /** Rejects when the body is no longer here. */
  read(id: string): Promise<Uint8Array>;
  remove(id: string): Promise<void>;
}

export const OWN_BODY_PREFIX = 'own:';

export function isOwnBodyId(id: string): boolean {
  return id.startsWith(OWN_BODY_PREFIX);
}

function newOwnBody(body: Omit<OwnBody, 'id' | 'addedAt'>, now: Date): OwnBody {
  return { ...body, id: `${OWN_BODY_PREFIX}${crypto.randomUUID()}`, addedAt: now.toISOString() };
}

function gone(): Error {
  return new Error('That body is no longer in this browser.');
}

/** For tests: the same shelf in a map. */
export class InMemoryBodyShelf implements BodyShelf {
  private readonly bodies = new Map<string, { body: OwnBody; data: Uint8Array }>();

  async list(): Promise<readonly OwnBody[]> {
    return [...this.bodies.values()].map((entry) => entry.body);
  }

  async add(body: Omit<OwnBody, 'id' | 'addedAt'>, data: Uint8Array): Promise<OwnBody> {
    const kept = newOwnBody(body, new Date());
    this.bodies.set(kept.id, { body: kept, data });
    return kept;
  }

  async read(id: string): Promise<Uint8Array> {
    const entry = this.bodies.get(id);
    if (entry === undefined) throw gone();
    return entry.data;
  }

  async remove(id: string): Promise<void> {
    this.bodies.delete(id);
  }
}

const DB_NAME = 'latentpresence-bodies';
const BODIES = 'bodies';
const FILES = 'files';

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
export class IndexedDbBodyShelf implements BodyShelf {
  private readonly factory: IDBFactory;
  private db: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory = globalThis.indexedDB) {
    this.factory = factory;
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, 1);
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore(BODIES, { keyPath: 'id' });
        request.result.createObjectStore(FILES);
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB would not open')));
    });
    return this.db;
  }

  async list(): Promise<readonly OwnBody[]> {
    const db = await this.open();
    const bodies = (await done(db.transaction(BODIES).objectStore(BODIES).getAll())) as OwnBody[];
    return bodies.toSorted((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  async add(body: Omit<OwnBody, 'id' | 'addedAt'>, data: Uint8Array): Promise<OwnBody> {
    const db = await this.open();
    const kept = newOwnBody(body, new Date());
    const transaction = db.transaction([BODIES, FILES], 'readwrite');
    transaction.objectStore(BODIES).put(kept);
    // A copy of exactly these bytes: the view may sit on a larger buffer.
    transaction.objectStore(FILES).put(data.slice().buffer, kept.id);
    await committed(transaction);
    return kept;
  }

  async read(id: string): Promise<Uint8Array> {
    const db = await this.open();
    const stored = (await done(db.transaction(FILES).objectStore(FILES).get(id))) as ArrayBuffer | undefined;
    if (stored === undefined) throw gone();
    return new Uint8Array(stored);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([BODIES, FILES], 'readwrite');
    transaction.objectStore(BODIES).delete(id);
    transaction.objectStore(FILES).delete(id);
    await committed(transaction);
  }
}

let shared: BodyShelf | null = null;

/** The page's shelf: this browser's IndexedDB, or a shelf that lasts the visit where there is none. */
export function defaultBodyShelf(): BodyShelf {
  shared ??= typeof globalThis.indexedDB === 'undefined' ? new InMemoryBodyShelf() : new IndexedDbBodyShelf();
  return shared;
}
