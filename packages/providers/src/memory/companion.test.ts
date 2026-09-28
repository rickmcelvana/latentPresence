import { companionRoutes, type MemoryEpisode, type PlanDocument, type RetrievalRequest, type SelfModelBlock, type SemanticFact } from '@latentpresence/protocol';
import { MemoryStoreError } from '@latentpresence/core';
import { describe, expect, it, vi } from 'vitest';
import { CompanionMemoryStore } from './companion';

const BASE_URL = 'http://127.0.0.1:8787';

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly body: unknown;
}

function fakeFetch(handler: (request: RecordedRequest) => Response): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: new URL(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    requests.push(request);
    return handler(request);
  });
  return { fetch: fetch as unknown as typeof fetch, requests };
}

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const episode: MemoryEpisode = {
  id: 'ep-1',
  sessionId: 'session-1',
  characterId: 'char-1',
  role: 'user',
  text: 'hello',
  interrupted: false,
  at: '2026-01-01T00:00:00.000Z',
  embedding: null,
  affect: null,
};

const fact: SemanticFact = {
  id: 'fact-1',
  characterId: 'char-1',
  subject: 'user',
  predicate: 'likes',
  object: 'tea',
  confidence: 0.8,
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: null,
  recordedAt: '2026-01-01T00:00:00.000Z',
  sourceEpisodeId: null,
  embedding: null,
};

const block: SelfModelBlock = { characterId: 'char-1', name: 'persona', content: 'Warm.', updatedAt: '2026-01-01T00:00:00.000Z', editableByCharacter: true };

const plan: PlanDocument = {
  id: 'plan-1',
  characterId: 'char-1',
  title: 'Garden',
  goal: 'Tomatoes',
  phases: [],
  status: 'draft',
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const retrievalRequest: RetrievalRequest = {
  characterId: 'char-1',
  sessionId: 'session-1',
  query: 'tea',
  queryEmbedding: null,
  limits: { episodes: 5, facts: 5, documents: 0 },
  since: null,
};

describe('CompanionMemoryStore', () => {
  it('has id mariadb and needs no network for capabilities', async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error('should not be called');
    });
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    expect(store.id).toBe('mariadb');
    expect(await store.capabilities()).toEqual({ vectorSearch: true, dimensions: null, bitemporalFacts: true, plans: true, schedules: false, remote: true });
  });

  it('retrieve calls dbRetrieve with the request as the body', async () => {
    const bundle = { episodes: [], facts: [], blocks: [], documents: [], vectorSearch: 'no-query-embedding', elapsedMs: 3 };
    const { fetch, requests } = fakeFetch(() => ok(bundle));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    const result = await store.retrieve(retrievalRequest);
    expect(result).toEqual(bundle);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe(companionRoutes.dbRetrieve.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbRetrieve.path);
    expect(requests[0]?.body).toEqual(retrievalRequest);
  });

  it('appendEpisode calls dbAppendEpisode with the episode as the body', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ ok: true }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    await store.appendEpisode(episode);
    expect(requests[0]?.method).toBe(companionRoutes.dbAppendEpisode.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbAppendEpisode.path);
    expect(requests[0]?.body).toEqual(episode);
  });

  it('upsertFact calls dbUpsertFact with the fact as the body', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ ok: true }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    await store.upsertFact(fact);
    expect(requests[0]?.method).toBe(companionRoutes.dbUpsertFact.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbUpsertFact.path);
    expect(requests[0]?.body).toEqual(fact);
  });

  it('supersedeFact calls dbSupersedeFact with { id, validTo }', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ ok: true }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    await store.supersedeFact('fact-1', '2026-02-01T00:00:00.000Z');
    expect(requests[0]?.method).toBe(companionRoutes.dbSupersedeFact.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbSupersedeFact.path);
    expect(requests[0]?.body).toEqual({ id: 'fact-1', validTo: '2026-02-01T00:00:00.000Z' });
  });

  it('expireFact calls dbExpireFact with { id, at }', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ ok: true }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    await store.expireFact('fact-1', '2026-02-01T00:00:00.000Z');
    expect(requests[0]?.method).toBe(companionRoutes.dbExpireFact.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbExpireFact.path);
    expect(requests[0]?.body).toEqual({ id: 'fact-1', at: '2026-02-01T00:00:00.000Z' });
  });

  it('currentFacts calls dbCurrentFacts with the character as a query param and returns .facts', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ facts: [fact] }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    const result = await store.currentFacts('char-1');
    expect(result).toEqual([fact]);
    expect(requests[0]?.method).toBe(companionRoutes.dbCurrentFacts.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbCurrentFacts.path);
    expect(requests[0]?.url.searchParams.get('characterId')).toBe('char-1');
  });

  it('deleteFact and deleteEpisode call their DELETE routes with the id in the path, encoded', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ ok: true }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    await store.deleteFact('fact/1');
    await store.deleteEpisode('ep 1');
    expect(requests.map((request) => request.method)).toEqual([companionRoutes.dbDeleteFact.method, companionRoutes.dbDeleteEpisode.method]);
    expect(requests.map((request) => request.url.pathname)).toEqual([
      companionRoutes.dbDeleteFact.path.replace(':id', 'fact%2F1'),
      companionRoutes.dbDeleteEpisode.path.replace(':id', 'ep%201'),
    ]);
  });

  it('listEpisodes calls dbListEpisodes with the character, and before only when given', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ episodes: [episode] }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    expect(await store.listEpisodes('char-1', null)).toEqual([episode]);
    await store.listEpisodes('char-1', '2026-01-02T00:00:00.000Z');
    expect(requests[0]?.method).toBe(companionRoutes.dbListEpisodes.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbListEpisodes.path);
    expect(requests[0]?.url.searchParams.has('before')).toBe(false);
    expect(requests[1]?.url.searchParams.get('before')).toBe('2026-01-02T00:00:00.000Z');
    expect(requests[1]?.url.searchParams.get('characterId')).toBe('char-1');
  });

  it('readBlocks calls dbReadBlocks with the character as a query param and returns .blocks', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ blocks: [block] }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    const result = await store.readBlocks('char-1');
    expect(result).toEqual([block]);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbReadBlocks.path);
    expect(requests[0]?.url.searchParams.get('characterId')).toBe('char-1');
  });

  it('writeBlock calls dbWriteBlock with the block as the body', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ ok: true }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    await store.writeBlock(block);
    expect(requests[0]?.method).toBe(companionRoutes.dbWriteBlock.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbWriteBlock.path);
    expect(requests[0]?.body).toEqual(block);
  });

  it('savePlan calls dbSavePlan with the plan as the body', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ ok: true }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    await store.savePlan(plan);
    expect(requests[0]?.method).toBe(companionRoutes.dbSavePlan.method);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbSavePlan.path);
    expect(requests[0]?.body).toEqual(plan);
  });

  it('listPlans calls dbListPlans with the character as a query param and returns .plans', async () => {
    const { fetch, requests } = fakeFetch(() => ok({ plans: [plan] }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    const result = await store.listPlans('char-1');
    expect(result).toEqual([plan]);
    expect(requests[0]?.url.pathname).toBe(companionRoutes.dbListPlans.path);
    expect(requests[0]?.url.searchParams.get('characterId')).toBe('char-1');
  });

  it('an error body becomes a MemoryStoreError with the same code', async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such fact', details: null } }), { status: 404 }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    await expect(store.expireFact('nope', '2026-01-01T00:00:00.000Z')).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.expireFact('nope', '2026-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(MemoryStoreError);
  });

  it('a garbled error body becomes internal, with the HTTP status in the message', async () => {
    const { fetch } = fakeFetch(() => new Response('not json', { status: 500 }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    const error: unknown = await store.expireFact('nope', '2026-01-01T00:00:00.000Z').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MemoryStoreError);
    expect((error as MemoryStoreError).code).toBe('internal');
    expect((error as MemoryStoreError).message).toContain('500');
  });

  it('a 2xx body that does not parse becomes internal, naming the route', async () => {
    const { fetch } = fakeFetch(() => ok({ nonsense: true }));
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
    const error: unknown = await store.currentFacts('char-1').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MemoryStoreError);
    expect((error as MemoryStoreError).code).toBe('internal');
    expect((error as MemoryStoreError).message).toContain('dbCurrentFacts');
  });

  it('a rejected fetch becomes unavailable, naming the URL', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch: fetch as unknown as typeof globalThis.fetch });
    const error: unknown = await store.currentFacts('char-1').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MemoryStoreError);
    expect((error as MemoryStoreError).code).toBe('unavailable');
    expect((error as MemoryStoreError).message).toContain(BASE_URL);
  });

  describe('schedules', () => {
    it('refuse with unavailable, without ever fetching', async () => {
      const { fetch } = fakeFetch(() => {
        throw new Error('should not be called');
      });
      const store = new CompanionMemoryStore({ baseUrl: BASE_URL, fetch });
      await expect(store.listSchedules('char-1')).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        store.saveSchedule({
          id: 's-1',
          characterId: 'char-1',
          description: 'Water the seedlings',
          trigger: { kind: 'cron', expression: '0 8 * * *', timeZone: 'America/Toronto' },
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
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(store.deleteSchedule('s-1')).rejects.toMatchObject({ code: 'unavailable' });
    });
  });
});
