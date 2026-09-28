import {
  episodeText,
  factText,
  isCurrentFact,
  MemoryStoreError,
  rankHits,
  sameModel,
  vectorSearchOutcome,
  words,
} from '@latentpresence/core';
import type {
  Embedding,
  EmbeddingModelRef,
  MemoryCapabilities,
  MemoryEpisode,
  MemoryStore,
  PlanDocument,
  RetrievalBundle,
  RetrievalRequest,
  Schedule,
  SelfModelBlock,
  SemanticFact,
} from '@latentpresence/protocol';

/**
 * `MemoryStore` in the browser's own IndexedDB (P4-T04, ADR-05): the store for a page with
 * no companion running. Ranking is `packages/core`'s `local-search.ts`, the same functions
 * `FakeMemoryStore` runs, so the browser cannot rank a query differently from the fake the
 * kernel is tested against — only how the rows are fetched differs.
 *
 * **Brute force is the plan's word, and fine at a person's scale**: `retrieve` loads a
 * character's rows by the `characterId` index and ranks them in memory rather than using
 * an approximate index, which IndexedDB has no primitive for anyway.
 */
export interface IndexedDbMemoryStoreConfig {
  /** Defaults to `globalThis.indexedDB`. Tests pass `fake-indexeddb`'s `IDBFactory`, never a global polyfill. */
  readonly indexedDB?: IDBFactory;
  /** Defaults to `'latentpresence-memory'`. Two names never share data (same factory or not). */
  readonly name?: string;
  readonly now?: () => Date;
}

const DB_VERSION = 1;

/** A fact as the store keeps it: the real vector beside the row, plus the retraction the
 * public `SemanticFact` shape has no field for. */
type StoredFact = Omit<SemanticFact, 'embedding'> & { embedding: Embedding | null; expiredAt: string | null };
type CollectionName = 'turns' | 'facts';
interface CollectionRow {
  readonly collection: CollectionName;
  readonly model: EmbeddingModelRef;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('indexeddb request failed')));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('error', () => reject(tx.error ?? new Error('indexeddb transaction failed')));
    tx.addEventListener('abort', () => reject(tx.error ?? new Error('indexeddb transaction aborted')));
  });
}

function toEpisode(record: MemoryEpisode): MemoryEpisode {
  return { ...record, embedding: null };
}

function toFact(record: StoredFact): SemanticFact {
  const { expiredAt: _expiredAt, ...fact } = record;
  return { ...fact, embedding: null };
}

export class IndexedDbMemoryStore implements MemoryStore {
  readonly id = 'indexeddb';
  private readonly factory: IDBFactory;
  private readonly name: string;
  private readonly now: () => Date;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(config: IndexedDbMemoryStoreConfig = {}) {
    this.factory = config.indexedDB ?? globalThis.indexedDB;
    this.name = config.name ?? 'latentpresence-memory';
    this.now = config.now ?? (() => new Date());
  }

  async capabilities(): Promise<MemoryCapabilities> {
    const db = await this.open();
    const tx = db.transaction('collections', 'readonly');
    const turns = await requestToPromise<CollectionRow | undefined>(tx.objectStore('collections').get('turns'));
    await txDone(tx);
    return { vectorSearch: true, dimensions: turns?.model.dimensions ?? null, bitemporalFacts: true, plans: true, schedules: true, remote: false };
  }

  async appendEpisode(episode: MemoryEpisode): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['episodes', 'collections'], 'readwrite');
    const store = tx.objectStore('episodes');
    const existing = await requestToPromise<MemoryEpisode | undefined>(store.get(episode.id));
    if (existing === undefined) {
      store.put(episode);
      await this.claim(tx, 'turns', episode.embedding);
    }
    await txDone(tx);
  }

  async upsertFact(fact: SemanticFact): Promise<void> {
    if (fact.validTo !== null && Date.parse(fact.validTo) < Date.parse(fact.validFrom)) {
      throw new MemoryStoreError('bad_request', `fact ${fact.id} cannot end before it began`);
    }
    const db = await this.open();
    const tx = db.transaction(['facts', 'collections'], 'readwrite');
    const store = tx.objectStore('facts');
    const existing = await requestToPromise<StoredFact | undefined>(store.get(fact.id));
    const record: StoredFact = { ...fact, embedding: fact.embedding ?? existing?.embedding ?? null, expiredAt: existing?.expiredAt ?? null };
    store.put(record);
    await this.claim(tx, 'facts', fact.embedding);
    await txDone(tx);
  }

  async supersedeFact(id: string, validTo: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('facts', 'readwrite');
    const store = tx.objectStore('facts');
    const existing = await requestToPromise<StoredFact | undefined>(store.get(id));
    if (existing === undefined) {
      tx.abort();
      throw new MemoryStoreError('not_found', `no fact with id ${id}`);
    }
    if (Date.parse(validTo) < Date.parse(existing.validFrom)) {
      tx.abort();
      throw new MemoryStoreError('bad_request', `fact ${id} cannot end (${validTo}) before it began (${existing.validFrom})`);
    }
    store.put({ ...existing, validTo });
    await txDone(tx);
  }

  async expireFact(id: string, at: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('facts', 'readwrite');
    const store = tx.objectStore('facts');
    const existing = await requestToPromise<StoredFact | undefined>(store.get(id));
    if (existing === undefined) {
      tx.abort();
      throw new MemoryStoreError('not_found', `no fact with id ${id}`);
    }
    store.put({ ...existing, expiredAt: existing.expiredAt ?? at }); // a retry cannot move the first expiry, as in the companion
    await txDone(tx);
  }

  async currentFacts(characterId: string): Promise<SemanticFact[]> {
    const db = await this.open();
    const tx = db.transaction('facts', 'readonly');
    const rows = await this.factsByCharacter(tx, characterId);
    await txDone(tx);
    const now = this.now().getTime();
    return rows.filter((row) => isCurrentFact(row.expiredAt, row.validTo, now)).map(toFact);
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalBundle> {
    const db = await this.open();
    const tx = db.transaction(['episodes', 'facts', 'blocks', 'collections'], 'readonly');
    const [episodeRows, factRows, blockRows, activeTurns, activeFacts] = await Promise.all([
      this.episodesByCharacter(tx, request.characterId),
      this.factsByCharacter(tx, request.characterId),
      requestToPromise<SelfModelBlock[]>(tx.objectStore('blocks').index('characterId').getAll(request.characterId)),
      requestToPromise<CollectionRow | undefined>(tx.objectStore('collections').get('turns')),
      requestToPromise<CollectionRow | undefined>(tx.objectStore('collections').get('facts')),
    ]);
    await txDone(tx);

    const query = words(request.query);
    const probe = request.queryEmbedding;
    const vectorSearch = vectorSearchOutcome(probe, activeTurns?.model);
    const queryVector = vectorSearch === 'used' ? probe : null;

    const episodes = episodeRows
      .filter((row) => row.sessionId !== request.sessionId && (request.since === null || Date.parse(row.at) >= Date.parse(request.since)))
      .map((row) => ({ row: toEpisode(row), embedding: row.embedding }));
    const episodeHits = rankHits(episodes, query, episodeText, queryVector, request.limits.episodes);

    const now = this.now().getTime();
    const factQueryVector = queryVector !== null && activeFacts !== undefined && sameModel(activeFacts.model, queryVector.model) ? queryVector : null;
    const facts = factRows
      .filter((row) => isCurrentFact(row.expiredAt, row.validTo, now))
      .map((row) => ({ row: toFact(row), embedding: row.embedding }));
    const factHits = rankHits(facts, query, factText, factQueryVector, request.limits.facts);

    return {
      episodes: episodeHits,
      facts: factHits,
      blocks: blockRows.toSorted((a, b) => a.name.localeCompare(b.name)),
      documents: [],
      vectorSearch,
      elapsedMs: 0,
    };
  }

  async readBlocks(characterId: string): Promise<SelfModelBlock[]> {
    const db = await this.open();
    const tx = db.transaction('blocks', 'readonly');
    const rows = await requestToPromise<SelfModelBlock[]>(tx.objectStore('blocks').index('characterId').getAll(characterId));
    await txDone(tx);
    return rows.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async writeBlock(block: SelfModelBlock): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('blocks', 'readwrite');
    tx.objectStore('blocks').put(block);
    await txDone(tx);
  }

  async savePlan(plan: PlanDocument): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('plans', 'readwrite');
    const store = tx.objectStore('plans');
    const existing = await requestToPromise<PlanDocument | undefined>(store.get(plan.id));
    const expected = existing === undefined ? 1 : existing.version + 1;
    if (plan.version !== expected) {
      tx.abort();
      throw new MemoryStoreError('conflict', `plan ${plan.id} must be saved at version ${expected}`);
    }
    store.put(plan);
    await txDone(tx);
  }

  async listPlans(characterId: string): Promise<PlanDocument[]> {
    const db = await this.open();
    const tx = db.transaction('plans', 'readonly');
    const rows = await requestToPromise<PlanDocument[]>(tx.objectStore('plans').index('characterId').getAll(characterId));
    await txDone(tx);
    return rows.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async listSchedules(characterId: string): Promise<Schedule[]> {
    const db = await this.open();
    const tx = db.transaction('schedules', 'readonly');
    const rows = await requestToPromise<Schedule[]>(tx.objectStore('schedules').index('characterId').getAll(characterId));
    await txDone(tx);
    return rows;
  }

  async saveSchedule(schedule: Schedule): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('schedules', 'readwrite');
    tx.objectStore('schedules').put(schedule);
    await txDone(tx);
  }

  async deleteSchedule(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('schedules', 'readwrite');
    tx.objectStore('schedules').delete(id);
    await txDone(tx);
  }

  private episodesByCharacter(tx: IDBTransaction, characterId: string): Promise<MemoryEpisode[]> {
    return requestToPromise<MemoryEpisode[]>(tx.objectStore('episodes').index('characterId').getAll(characterId));
  }

  private factsByCharacter(tx: IDBTransaction, characterId: string): Promise<StoredFact[]> {
    return requestToPromise<StoredFact[]>(tx.objectStore('facts').index('characterId').getAll(characterId));
  }

  /** The first model to write a collection becomes its active one (ADR-36, as the fake and the companion). */
  private async claim(tx: IDBTransaction, collection: CollectionName, embedding: Embedding | null): Promise<void> {
    if (embedding === null) return;
    const store = tx.objectStore('collections');
    const existing = await requestToPromise<CollectionRow | undefined>(store.get(collection));
    if (existing === undefined) store.put({ collection, model: embedding.model } satisfies CollectionRow);
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise === null) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = this.factory.open(this.name, DB_VERSION);
        request.addEventListener('upgradeneeded', () => {
          const db = request.result;
          const episodes = db.createObjectStore('episodes', { keyPath: 'id' });
          episodes.createIndex('characterId', 'characterId');
          const facts = db.createObjectStore('facts', { keyPath: 'id' });
          facts.createIndex('characterId', 'characterId');
          const blocks = db.createObjectStore('blocks', { keyPath: ['characterId', 'name'] });
          blocks.createIndex('characterId', 'characterId');
          const plans = db.createObjectStore('plans', { keyPath: 'id' });
          plans.createIndex('characterId', 'characterId');
          const schedules = db.createObjectStore('schedules', { keyPath: 'id' });
          schedules.createIndex('characterId', 'characterId');
          db.createObjectStore('collections', { keyPath: 'collection' });
        });
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error ?? new Error(`failed to open indexeddb database ${this.name}`)));
      });
    }
    return this.dbPromise;
  }
}
