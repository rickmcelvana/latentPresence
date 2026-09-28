import { describeMemoryStoreConformance } from '@latentpresence/core/memory-conformance';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbMemoryStore } from './indexeddb';

describeMemoryStoreConformance({
  name: 'IndexedDbMemoryStore',
  create: () => new IndexedDbMemoryStore({ indexedDB: new IDBFactory() }),
  vectors: true,
});

describe('IndexedDbMemoryStore persistence', () => {
  it('a second instance on the same factory and name reads what the first wrote', async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbMemoryStore({ indexedDB: factory, name: 'shared' });
    await first.appendEpisode({
      id: 'ep-1',
      sessionId: 'session-1',
      characterId: 'char-1',
      role: 'user',
      text: 'We talked about the loganberry harvest',
      interrupted: false,
      at: '2026-01-01T00:00:00.000Z',
      embedding: null,
      affect: null,
    });

    const second = new IndexedDbMemoryStore({ indexedDB: factory, name: 'shared' });
    const bundle = await second.retrieve({
      characterId: 'char-1',
      sessionId: 'session-2',
      query: 'loganberry',
      queryEmbedding: null,
      limits: { episodes: 10, facts: 10, documents: 0 },
      since: null,
    });
    expect(bundle.episodes).toHaveLength(1);
    expect(bundle.episodes[0]?.id).toBe('ep-1');
  });

  it('two different names do not share data', async () => {
    const factory = new IDBFactory();
    const a = new IndexedDbMemoryStore({ indexedDB: factory, name: 'store-a' });
    const b = new IndexedDbMemoryStore({ indexedDB: factory, name: 'store-b' });
    await a.appendEpisode({
      id: 'ep-a',
      sessionId: 'session-1',
      characterId: 'char-1',
      role: 'user',
      text: 'A secret about the tamarillo',
      interrupted: false,
      at: '2026-01-01T00:00:00.000Z',
      embedding: null,
      affect: null,
    });

    const bundle = await b.retrieve({
      characterId: 'char-1',
      sessionId: 'session-2',
      query: 'tamarillo',
      queryEmbedding: null,
      limits: { episodes: 10, facts: 10, documents: 0 },
      since: null,
    });
    expect(bundle.episodes).toEqual([]);
  });
});
