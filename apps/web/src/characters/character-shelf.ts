import { PersonaSchema, type Persona } from '@latentpresence/protocol';

/**
 * The person's own characters (P11-T01, ADR-74): a persona and the body it wears when nothing is
 * chosen, kept in this browser's IndexedDB beside their own bodies and plugins. Never in the memory
 * store (a self block holds 2,000 characters, and a character exists before it has a database),
 * and never sent anywhere.
 *
 * The persona's `id` is the memory namespace, made once by `newCharacterId` and never changed:
 * renaming a character changes its `name` only.
 */
export interface StoredCharacter {
  readonly persona: Persona;
  /** A built-in body's id or an own body's (`own:…`); one that is gone falls back to the placeholder. */
  readonly defaultBody: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CharacterShelf {
  /** Every character kept here that still reads as a persona, in no particular order. */
  list(): Promise<readonly StoredCharacter[]>;
  /** Adds or replaces by `persona.id`, which must be one of the person's (`u-…`). */
  put(character: StoredCharacter): Promise<void>;
  remove(id: string): Promise<void>;
  /** Called after every put or remove on this shelf, so every list on the page follows. */
  subscribe(listener: () => void): () => void;
}

/** Every id of the person's starts with this, so none can ever be a built-in one (ADR-74 item 3). */
export const OWN_CHARACTER_PREFIX = 'u-';

export function isOwnCharacterId(id: string): boolean {
  return id.startsWith(OWN_CHARACTER_PREFIX) && id.length > OWN_CHARACTER_PREFIX.length;
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SLUG_LENGTH = 24;

/**
 * `u-` + the name in lowercase letters and digits + four random characters (`u-madame-vey-7k2q`):
 * readable in a database row, and unique without asking the shelf.
 */
export function newCharacterId(name: string, random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, SLUG_LENGTH)
      .replace(/-+$/u, '') || 'character';
  const tail = [...random(new Uint8Array(4))].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
  return `${OWN_CHARACTER_PREFIX}${slug}-${tail}`;
}

/**
 * A stored record read back: anything that no longer parses (an older app wrote it, or someone
 * edited the database by hand) is left out rather than failing the whole list.
 */
function readBack(value: unknown): StoredCharacter | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const persona = PersonaSchema.safeParse(record['persona']);
  if (!persona.success || !isOwnCharacterId(persona.data.id)) return null;
  const text = (key: string): string => (typeof record[key] === 'string' ? record[key] : '');
  return { persona: persona.data, defaultBody: text('defaultBody'), createdAt: text('createdAt'), updatedAt: text('updatedAt') };
}

function checked(character: StoredCharacter): StoredCharacter {
  const persona = PersonaSchema.parse(character.persona);
  if (!isOwnCharacterId(persona.id)) throw new Error(`"${persona.id}" is not an id of yours: every character you make has one starting with ${OWN_CHARACTER_PREFIX}.`);
  return { ...character, persona };
}

class Listeners {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** For tests, and a browser without IndexedDB: the same shelf in a map, for the visit. */
export class InMemoryCharacterShelf implements CharacterShelf {
  private readonly characters = new Map<string, StoredCharacter>();
  private readonly listeners = new Listeners();

  constructor(initial: readonly StoredCharacter[] = []) {
    for (const character of initial) this.characters.set(character.persona.id, checked(character));
  }

  async list(): Promise<readonly StoredCharacter[]> {
    return [...this.characters.values()];
  }

  async put(character: StoredCharacter): Promise<void> {
    const kept = checked(character);
    this.characters.set(kept.persona.id, kept);
    this.listeners.notify();
  }

  async remove(id: string): Promise<void> {
    this.characters.delete(id);
    this.listeners.notify();
  }

  subscribe(listener: () => void): () => void {
    return this.listeners.subscribe(listener);
  }
}

const DB_NAME = 'latentpresence-characters';
const CHARACTERS = 'characters';

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
export class IndexedDbCharacterShelf implements CharacterShelf {
  private readonly factory: IDBFactory;
  private db: Promise<IDBDatabase> | null = null;
  private readonly listeners = new Listeners();

  constructor(factory: IDBFactory = globalThis.indexedDB) {
    this.factory = factory;
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, 1);
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore(CHARACTERS, { keyPath: 'persona.id' });
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB would not open')));
    });
    return this.db;
  }

  async list(): Promise<readonly StoredCharacter[]> {
    const db = await this.open();
    const stored = (await done(db.transaction(CHARACTERS).objectStore(CHARACTERS).getAll())) as unknown[];
    return stored.flatMap((value) => readBack(value) ?? []);
  }

  async put(character: StoredCharacter): Promise<void> {
    const kept = checked(character);
    const db = await this.open();
    const transaction = db.transaction(CHARACTERS, 'readwrite');
    transaction.objectStore(CHARACTERS).put(kept);
    await committed(transaction);
    this.listeners.notify();
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(CHARACTERS, 'readwrite');
    transaction.objectStore(CHARACTERS).delete(id);
    await committed(transaction);
    this.listeners.notify();
  }

  subscribe(listener: () => void): () => void {
    return this.listeners.subscribe(listener);
  }
}

let shared: CharacterShelf | null = null;

/** The page's shelf: this browser's IndexedDB, or one that lasts the visit where there is none. */
export function defaultCharacterShelf(): CharacterShelf {
  shared ??= typeof globalThis.indexedDB === 'undefined' ? new InMemoryCharacterShelf() : new IndexedDbCharacterShelf();
  return shared;
}
