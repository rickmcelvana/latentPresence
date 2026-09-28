import { MemoryStoreError } from '@latentpresence/core';
import { describe, expect, it } from 'vitest';
import { SqliteMemoryStore } from './sqlite';

describe('SqliteMemoryStore', () => {
  it('reports itself and no capabilities, and refuses every other call as unavailable', async () => {
    const store = new SqliteMemoryStore();
    expect(store.id).toBe('sqlite');
    expect(await store.capabilities()).toEqual({ vectorSearch: false, dimensions: null, bitemporalFacts: false, plans: false, schedules: false, remote: false });

    const calls: Array<() => Promise<unknown>> = [
      () => store.retrieve({ characterId: 'c', sessionId: 's', query: '', queryEmbedding: null, limits: { episodes: 0, facts: 0, documents: 0 }, since: null }),
      () => store.appendEpisode({ id: 'e', sessionId: 's', characterId: 'c', role: 'user', text: '', interrupted: false, at: '2026-01-01T00:00:00.000Z', embedding: null, affect: null }),
      () => store.upsertFact({ id: 'f', characterId: 'c', subject: 's', predicate: 'p', object: 'o', confidence: 0.5, validFrom: '2026-01-01T00:00:00.000Z', validTo: null, recordedAt: '2026-01-01T00:00:00.000Z', sourceEpisodeId: null, embedding: null }),
      () => store.supersedeFact('f', '2026-01-01T00:00:00.000Z'),
      () => store.expireFact('f', '2026-01-01T00:00:00.000Z'),
      () => store.currentFacts('c'),
      () => store.readBlocks('c'),
      () => store.writeBlock({ characterId: 'c', name: 'persona', content: '', updatedAt: '2026-01-01T00:00:00.000Z', editableByCharacter: true }),
      () => store.savePlan({ id: 'p', characterId: 'c', title: 't', goal: 'g', phases: [], status: 'draft', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' }),
      () => store.listPlans('c'),
      () => store.listSchedules('c'),
      () =>
        store.saveSchedule({
          id: 's',
          characterId: 'c',
          description: 'd',
          trigger: { kind: 'cron', expression: '0 8 * * *', timeZone: 'UTC' },
          taskPrompt: '',
          allowedTools: [],
          delivery: 'notify',
          catchUp: 'skip',
          runOn: 'core',
          status: 'active',
          lastRunAt: null,
          nextRunAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      () => store.deleteSchedule('s'),
    ];

    for (const call of calls) {
      const error: unknown = await call().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(MemoryStoreError);
      expect((error as MemoryStoreError).code).toBe('unavailable');
    }
  });
});
