import {
  EPISODE_PAGE_SIZE,
  MemoryCapabilitiesSchema,
  RetrievalBundleSchema,
  type EmbeddingModelRef,
  type MemoryEpisode,
  type MemoryStore,
  type PlanDocument,
  type RetrievalRequest,
  type Schedule,
  type SelfModelBlock,
  type SemanticFact,
  type UserAffect,
} from '@latentpresence/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryStoreError, type MemoryStoreErrorCode } from './errors';

/**
 * The `MemoryStore` conformance suite (P4-T04): what every adapter must do, whatever is
 * behind it. `FakeMemoryStore`, the companion's MariaDB store and the browser's IndexedDB
 * store each run it (`describeMemoryStoreConformance`), so the kernel can be tested on the
 * fake and trusted on the others.
 *
 * **It runs against shared, real backends.** Every test makes its own character (a random
 * `conformance-` id), so a database that already holds data — the development MariaDB — is
 * fine, and nothing assumes an empty store. Time is the real clock, because a remote store
 * decides "still holds" by its own (`validTo > now`); tests keep their timestamps days away
 * from now. Vectors use `CONFORMANCE_MODEL`, which the companion's tests remove.
 *
 * The rules, in the order the tests take them:
 * - **namespaces**: nothing written for one character is read for another;
 * - **episodes**: idempotent by id; retrieval leaves out the asking session, honours `since`
 *   and the limits, and never returns a vector;
 * - **facts**: upsert by id; `supersedeFact` ends one (in the past, it stops being current;
 *   in the future, it is current until then); `expireFact` retracts one and a second expiry
 *   is harmless; unknown ids are `not_found`; an interval cannot end before it began;
 * - **browsing and deleting** (P4-T05, ADR-39): turns list newest first a page at a time;
 *   a deleted turn or fact is gone from every read, and a fact read from a deleted turn
 *   stays, unlinked;
 * - **blocks**: one per name, sorted by name, returned by `retrieve`;
 * - **plans**: saved whole, version 1 first and one more each save, else `conflict`; listed
 *   newest first;
 * - **schedules**: when `capabilities().schedules`;
 * - **vectors**: when the target says it searches them — nearest first, and `vectorSearch`
 *   says why a query vector was not used.
 */

export interface ConformanceTarget {
  readonly name: string;
  /** A store to run against. Called once per suite; tests never assume it is empty. */
  readonly create: () => MemoryStore | Promise<MemoryStore>;
  /** A reason to skip the whole suite (no companion configured), or null to run it. */
  readonly skip?: string | null;
  /** Whether the store searches vectors; the vector cases run only when it does. */
  readonly vectors: boolean;
}

/** The model the vector cases write with. The companion's own tests drop this provider's tables. */
export const CONFORMANCE_MODEL: EmbeddingModelRef = { provider: 'memory-api-test', model: 'conformance', dimensions: 4 };
const OTHER_MODEL: EmbeddingModelRef = { provider: 'memory-api-test', model: 'conformance-other', dimensions: 3 };

const DAY = 86_400_000;

function random(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Now plus `days`, as ISO-8601, whole milliseconds. */
function days(offset: number): string {
  return new Date(Date.now() + offset * DAY).toISOString();
}

function sameMoment(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
}

function episode(characterId: string, sessionId: string, text: string, overrides: Partial<MemoryEpisode> = {}): MemoryEpisode {
  return { id: random('ep'), sessionId, characterId, role: 'user', text, interrupted: false, at: days(-1), embedding: null, affect: null, ...overrides };
}

function fact(characterId: string, object: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: random('fact'),
    characterId,
    subject: 'user',
    predicate: 'likes',
    object,
    confidence: 0.75,
    validFrom: days(-30),
    validTo: null,
    recordedAt: days(-2),
    sourceEpisodeId: null,
    embedding: null,
    ...overrides,
  };
}

function request(characterId: string, query: string, overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return { characterId, sessionId: random('asking'), query, queryEmbedding: null, limits: { episodes: 10, facts: 10, documents: 0 }, since: null, ...overrides };
}

function plan(characterId: string, overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: random('plan'),
    characterId,
    title: 'Vegetable garden',
    goal: 'Tomatoes by August',
    phases: [
      {
        id: random('phase'),
        title: 'Prepare',
        tasks: [
          { id: random('task'), title: 'Test the soil', status: 'done', notes: 'pH 6.5' },
          { id: random('task'), title: 'Build the beds', status: 'doing', notes: '' },
        ],
      },
      { id: random('phase'), title: 'Plant', tasks: [{ id: random('task'), title: 'Seedlings in', status: 'todo', notes: '' }] },
    ],
    status: 'active',
    version: 1,
    updatedAt: days(-3),
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<MemoryStoreErrorCode> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryStoreError);
    return (error as MemoryStoreError).code;
  }
  throw new Error('expected the store to refuse, and it did not');
}

const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id);

export function describeMemoryStoreConformance(target: ConformanceTarget): void {
  describe.skipIf(target.skip !== undefined && target.skip !== null)(`MemoryStore conformance: ${target.name}`, () => {
    let store: MemoryStore;
    beforeAll(async () => {
      store = await target.create();
    });

    it('describes itself', async () => {
      expect(store.id.length).toBeGreaterThan(0);
      expect(MemoryCapabilitiesSchema.safeParse(await store.capabilities()).success).toBe(true);
    });

    describe('episodes', () => {
      it('are found by their words from another session, without their vectors, once however often written', async () => {
        const characterId = random('conformance');
        const written = episode(characterId, random('session'), 'We talked about the quokkaberry harvest');
        await store.appendEpisode(written);
        await store.appendEpisode(written); // a retry: same id, same row
        const bundle = await store.retrieve(request(characterId, 'quokkaberry'));
        expect(RetrievalBundleSchema.safeParse(bundle).success).toBe(true);
        expect(ids(bundle.episodes)).toEqual([written.id]);
        const [found] = bundle.episodes;
        expect(found?.text).toBe(written.text);
        expect(found?.sessionId).toBe(written.sessionId);
        expect(found?.role).toBe('user');
        expect(found?.interrupted).toBe(false);
        expect(found?.embedding).toBeNull();
        expect(sameMoment(found?.at ?? null, written.at)).toBe(true);
      });

      it('keep what the user heard of an interrupted answer, and the affect measured', async () => {
        const characterId = random('conformance');
        const affect: UserAffect = { valence: -0.4, arousal: 0.6, confidence: 0.7, label: 'angry', readings: [], at: days(-1) };
        const heard = episode(characterId, random('session'), 'Sorry, the zanzibarite was', { role: 'assistant', interrupted: true, affect: null });
        const said = episode(characterId, heard.sessionId, 'Stop talking about zanzibarite', { affect });
        await store.appendEpisode(heard);
        await store.appendEpisode(said);
        const bundle = await store.retrieve(request(characterId, 'zanzibarite'));
        const byId = new Map(bundle.episodes.map((row) => [row.id, row]));
        expect(byId.get(heard.id)?.interrupted).toBe(true);
        expect(byId.get(heard.id)?.role).toBe('assistant');
        expect(byId.get(said.id)?.affect?.label).toBe('angry');
        expect(byId.get(said.id)?.affect?.valence).toBeCloseTo(-0.4, 5);
      });

      it('leave out the session that is asking', async () => {
        const characterId = random('conformance');
        const sessionId = random('session');
        await store.appendEpisode(episode(characterId, sessionId, 'The marzipanolith was enormous'));
        const same = await store.retrieve(request(characterId, 'marzipanolith', { sessionId }));
        expect(same.episodes).toEqual([]);
        const other = await store.retrieve(request(characterId, 'marzipanolith'));
        expect(other.episodes).toHaveLength(1);
      });

      it('honour since and the limit', async () => {
        const characterId = random('conformance');
        const sessionId = random('session');
        const old = episode(characterId, sessionId, 'An old story about the fennelwick', { at: days(-20) });
        const recent = episode(characterId, sessionId, 'A new story about the fennelwick', { at: days(-2) });
        await store.appendEpisode(old);
        await store.appendEpisode(recent);
        const since = await store.retrieve(request(characterId, 'fennelwick', { since: days(-10) }));
        expect(ids(since.episodes)).toEqual([recent.id]);
        const limited = await store.retrieve(request(characterId, 'fennelwick', { limits: { episodes: 1, facts: 10, documents: 0 } }));
        expect(limited.episodes).toHaveLength(1);
      });

      it('belong to their character', async () => {
        const mine = random('conformance');
        const theirs = random('conformance');
        await store.appendEpisode(episode(mine, random('session'), 'My secret is the plumtrellis'));
        const bundle = await store.retrieve(request(theirs, 'plumtrellis'));
        expect(bundle.episodes).toEqual([]);
      });
    });

    describe('facts', () => {
      it('are current once written, found by their words, and upserted by id', async () => {
        const characterId = random('conformance');
        const written = fact(characterId, 'gooseberry chutney');
        await store.upsertFact(written);
        await store.upsertFact({ ...written, object: 'gooseberry jam', confidence: 0.9 });
        const current = await store.currentFacts(characterId);
        expect(ids(current)).toEqual([written.id]);
        const [read] = current;
        expect(read?.object).toBe('gooseberry jam');
        expect(read?.confidence).toBeCloseTo(0.9, 5);
        expect(read?.validTo).toBeNull();
        expect(read?.embedding).toBeNull();
        expect(sameMoment(read?.validFrom ?? null, written.validFrom)).toBe(true);
        expect(sameMoment(read?.recordedAt ?? null, written.recordedAt)).toBe(true);
        const bundle = await store.retrieve(request(characterId, 'gooseberry'));
        expect(ids(bundle.facts)).toEqual([written.id]);
      });

      it('keep the episode they came from', async () => {
        const characterId = random('conformance');
        const source = episode(characterId, random('session'), 'I like damsons');
        await store.appendEpisode(source);
        await store.upsertFact(fact(characterId, 'damsons', { sourceEpisodeId: source.id }));
        const [read] = await store.currentFacts(characterId);
        expect(read?.sourceEpisodeId).toBe(source.id);
      });

      it('stop being current when superseded in the past, and stay current until a future end', async () => {
        const characterId = random('conformance');
        const ended = fact(characterId, 'the old flat on quillon street');
        const ending = fact(characterId, 'the lease on quillon street');
        await store.upsertFact(ended);
        await store.upsertFact(ending);
        await store.supersedeFact(ended.id, days(-1));
        const end = days(30);
        await store.supersedeFact(ending.id, end);
        const current = await store.currentFacts(characterId);
        expect(ids(current)).toEqual([ending.id]);
        expect(sameMoment(current[0]?.validTo ?? null, end)).toBe(true);
        const bundle = await store.retrieve(request(characterId, 'quillon'));
        expect(ids(bundle.facts)).toEqual([ending.id]);
      });

      it('stop being believed when expired, and a second expiry is harmless', async () => {
        const characterId = random('conformance');
        const kept = fact(characterId, 'rhubarb crumble');
        const duplicate = fact(characterId, 'rhubarb crumble, again');
        await store.upsertFact(kept);
        await store.upsertFact(duplicate);
        await store.expireFact(duplicate.id, days(0));
        await store.expireFact(duplicate.id, days(0));
        expect(ids(await store.currentFacts(characterId))).toEqual([kept.id]);
        const bundle = await store.retrieve(request(characterId, 'rhubarb'));
        expect(ids(bundle.facts)).toEqual([kept.id]);
      });

      it('refuse unknown ids and an end before the beginning', async () => {
        const characterId = random('conformance');
        expect(await refusal(store.supersedeFact(random('nope'), days(0)))).toBe('not_found');
        expect(await refusal(store.expireFact(random('nope'), days(0)))).toBe('not_found');
        const written = fact(characterId, 'olives', { validFrom: days(-5) });
        await store.upsertFact(written);
        expect(await refusal(store.supersedeFact(written.id, days(-10)))).toMatch(/^(bad_request|database)$/);
        expect(ids(await store.currentFacts(characterId))).toEqual([written.id]);
      });

      it('belong to their character', async () => {
        const mine = random('conformance');
        const theirs = random('conformance');
        await store.upsertFact(fact(mine, 'persimmon'));
        expect(await store.currentFacts(theirs)).toEqual([]);
        expect((await store.retrieve(request(theirs, 'persimmon'))).facts).toEqual([]);
      });
    });

    describe('browsing and deleting (P4-T05, ADR-39)', () => {
      it('lists turns newest first, a page at a time, without their vectors', async () => {
        const characterId = random('conformance');
        const sessionId = random('session');
        const written = [5, 4, 3, 2, 1].map((ago) => episode(characterId, sessionId, `turn from ${ago} days ago`, { at: days(-ago) }));
        for (const row of written) await store.appendEpisode(row);
        const page = await store.listEpisodes(characterId, null);
        expect(ids(page)).toEqual(ids(written).toReversed());
        expect(page.every((row) => row.embedding === null)).toBe(true);
        expect(ids(await store.listEpisodes(characterId, written[2]!.at))).toEqual([written[1]!.id, written[0]!.id]);
        expect(await store.listEpisodes(random('conformance'), null)).toEqual([]);
        expect(EPISODE_PAGE_SIZE).toBe(50);
      });

      it('deletes a turn from every read, keeping the fact read from it, unlinked', async () => {
        const characterId = random('conformance');
        const doomed = episode(characterId, random('session'), 'The pomegranix secret');
        const kept = episode(characterId, doomed.sessionId, 'The pomegranix story');
        await store.appendEpisode(doomed);
        await store.appendEpisode(kept);
        const learned = fact(characterId, 'pomegranix', { sourceEpisodeId: doomed.id });
        await store.upsertFact(learned);
        await store.deleteEpisode(doomed.id);
        expect(ids(await store.listEpisodes(characterId, null))).toEqual([kept.id]);
        expect(ids((await store.retrieve(request(characterId, 'pomegranix'))).episodes)).toEqual([kept.id]);
        const [still] = await store.currentFacts(characterId);
        expect(still?.id).toBe(learned.id);
        expect(still?.sourceEpisodeId).toBeNull();
        expect(await refusal(store.deleteEpisode(doomed.id))).toBe('not_found');
      });

      it('deletes a fact from every read', async () => {
        const characterId = random('conformance');
        const doomed = fact(characterId, 'quincebloom tea');
        const kept = fact(characterId, 'quincebloom jam');
        await store.upsertFact(doomed);
        await store.upsertFact(kept);
        await store.deleteFact(doomed.id);
        expect(ids(await store.currentFacts(characterId))).toEqual([kept.id]);
        expect(ids((await store.retrieve(request(characterId, 'quincebloom'))).facts)).toEqual([kept.id]);
        expect(await refusal(store.deleteFact(doomed.id))).toBe('not_found');
      });
    });

    describe('self-model blocks', () => {
      const block = (characterId: string, name: string, content: string): SelfModelBlock => ({ characterId, name, content, updatedAt: days(-1), editableByCharacter: true });

      it('are one per name, sorted by name, and come back with retrieval', async () => {
        const characterId = random('conformance');
        await store.writeBlock(block(characterId, 'persona', 'Warm and curious.'));
        await store.writeBlock(block(characterId, 'boundaries', 'No medical advice.'));
        await store.writeBlock({ ...block(characterId, 'persona', 'Warm, curious, a little dry.'), editableByCharacter: false });
        const blocks = await store.readBlocks(characterId);
        expect(blocks.map((row) => row.name)).toEqual(['boundaries', 'persona']);
        expect(blocks[1]?.content).toBe('Warm, curious, a little dry.');
        expect(blocks[1]?.editableByCharacter).toBe(false);
        const bundle = await store.retrieve(request(characterId, ''));
        expect(bundle.blocks.map((row) => row.name)).toEqual(['boundaries', 'persona']);
        expect(await store.readBlocks(random('conformance'))).toEqual([]);
      });
    });

    describe('plans', () => {
      it('save whole, one version at a time, and list newest first', async () => {
        const characterId = random('conformance');
        const first = plan(characterId);
        await store.savePlan(first);
        expect(await store.listPlans(characterId)).toEqual([expect.objectContaining({ id: first.id, version: 1, phases: first.phases })]);

        const second: PlanDocument = { ...first, version: 2, status: 'done', updatedAt: days(-1), phases: [{ ...first.phases[0]!, tasks: [] }] };
        await store.savePlan(second);
        expect(await refusal(store.savePlan({ ...first, version: 2 }))).toBe('conflict');
        expect(await refusal(store.savePlan(plan(characterId, { version: 2 })))).toBe('conflict');

        const newer = plan(characterId, { title: 'Herb spiral', updatedAt: days(0) });
        await store.savePlan(newer);
        const plans = await store.listPlans(characterId);
        expect(ids(plans)).toEqual([newer.id, first.id]);
        expect(plans[1]).toMatchObject({ version: 2, status: 'done', phases: second.phases, title: first.title, goal: first.goal });
        expect(await store.listPlans(random('conformance'))).toEqual([]);
      });
    });

    describe('schedules', () => {
      it('save, list and delete, when the store keeps them', async (context) => {
        if (!(await store.capabilities()).schedules) context.skip();
        const characterId = random('conformance');
        const schedule: Schedule = {
          id: random('schedule'),
          characterId,
          description: 'Water the seedlings',
          trigger: { kind: 'cron', expression: '0 8 * * *', timeZone: 'America/Toronto' },
          taskPrompt: 'Remind them to water the seedlings.',
          allowedTools: [],
          delivery: 'notify',
          catchUp: 'skip',
          runOn: 'core',
          status: 'active',
          lastRunAt: null,
          nextRunAt: days(1),
          createdAt: days(-1),
        };
        await store.saveSchedule(schedule);
        await store.saveSchedule({ ...schedule, status: 'paused' });
        expect(await store.listSchedules(characterId)).toEqual([expect.objectContaining({ id: schedule.id, status: 'paused' })]);
        await store.deleteSchedule(schedule.id);
        expect(await store.listSchedules(characterId)).toEqual([]);
      });
    });

    describe.runIf(target.vectors)('vectors', () => {
      const vector = (values: number[]) => ({ model: CONFORMANCE_MODEL, vector: values });

      it('are searched nearest first, and say why a query vector was not used', async () => {
        const characterId = random('conformance');
        const sessionId = random('session');
        const near = episode(characterId, sessionId, 'one thing', { embedding: vector([1, 0, 0, 0]) });
        const far = episode(characterId, sessionId, 'another thing', { embedding: vector([0, 0, 1, 0]) });
        const between = episode(characterId, sessionId, 'a third thing', { embedding: vector([0.6, 0.8, 0, 0]) });
        await store.appendEpisode(far);
        await store.appendEpisode(near);
        await store.appendEpisode(between);
        await store.upsertFact(fact(characterId, 'vector fact', { embedding: vector([1, 0, 0, 0]) }));

        const used = await store.retrieve(request(characterId, '', { queryEmbedding: vector([0.9, 0.1, 0, 0]) }));
        expect(used.vectorSearch).toBe('used');
        expect(ids(used.episodes).slice(0, 2)).toEqual([near.id, between.id]);
        expect(used.episodes.every((row) => row.embedding === null)).toBe(true);
        expect(used.facts.map((row) => row.object)).toEqual(['vector fact']);
        expect(used.facts[0]?.embedding).toBeNull();

        expect((await store.retrieve(request(characterId, ''))).vectorSearch).toBe('no-query-embedding');
        const other = await store.retrieve(request(characterId, '', { queryEmbedding: { model: OTHER_MODEL, vector: [1, 0, 0] } }));
        expect(other.vectorSearch).toBe('other-model');
        expect(other.episodes).toEqual([]);
      });
    });
  });
}
