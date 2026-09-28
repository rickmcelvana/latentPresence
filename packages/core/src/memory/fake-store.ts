import {
  EPISODE_PAGE_SIZE,
  type Embedding,
  type EmbeddingModelRef,
  type MemoryCapabilities,
  type MemoryEpisode,
  type MemoryStore,
  type PlanDocument,
  type RetrievalBundle,
  type RetrievalRequest,
  type Schedule,
  type SelfModelBlock,
  type SemanticFact,
} from '@latentpresence/protocol';
import { MemoryStoreError } from './errors';
import { episodeText, factText, isCurrentFact, rankHits, sameModel, vectorSearchOutcome, words } from './local-search';

/**
 * `MemoryStore` in memory (P4-T03), for the kernel's tests and the replay. It keeps the
 * rules the MariaDB store keeps (P4-T02), so a test that passes here is about the kernel and
 * not about a friendlier store:
 *
 * - every read is scoped to one `characterId` (namespaces);
 * - retrieval leaves out the current session, and returns only current facts — not
 *   expired, `validTo` unset or in the future;
 * - vectors are searched only when the query's model is the collection's **active** one —
 *   the first model that wrote to it, as the companion's first-model rule (ADR-36) — and a
 *   vector is never returned;
 * - keyword search is word overlap, where the companion has FULLTEXT: good enough to rank.
 *
 * `rows` exposes everything, including expired and superseded facts, for assertions.
 */

interface StoredFact {
  fact: SemanticFact;
  embedding: Embedding | null;
  expiredAt: string | null;
}

interface StoredEpisode {
  episode: MemoryEpisode;
  embedding: Embedding | null;
}

export class FakeMemoryStore implements MemoryStore {
  readonly id = 'fake-memory';
  private readonly now: () => Date;
  private readonly episodes = new Map<string, StoredEpisode>();
  private readonly facts = new Map<string, StoredFact>();
  private readonly blocks = new Map<string, SelfModelBlock>();
  private readonly plans = new Map<string, PlanDocument>();
  private readonly schedules = new Map<string, Schedule>();
  private readonly active = new Map<'turns' | 'facts', EmbeddingModelRef>();
  /** Every call, by name, for tests that count round trips. */
  readonly calls: string[] = [];

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  get rows(): { readonly episodes: readonly StoredEpisode[]; readonly facts: readonly StoredFact[] } {
    return { episodes: [...this.episodes.values()], facts: [...this.facts.values()] };
  }

  async capabilities(): Promise<MemoryCapabilities> {
    return { vectorSearch: true, dimensions: this.active.get('turns')?.dimensions ?? null, bitemporalFacts: true, plans: true, schedules: true, remote: false };
  }

  async appendEpisode(episode: MemoryEpisode): Promise<void> {
    this.calls.push('appendEpisode');
    if (this.episodes.has(episode.id)) return;
    this.claim('turns', episode.embedding);
    this.episodes.set(episode.id, { episode: { ...episode, embedding: null }, embedding: episode.embedding });
  }

  async upsertFact(fact: SemanticFact): Promise<void> {
    this.calls.push('upsertFact');
    const existing = this.facts.get(fact.id);
    if (fact.validTo !== null && Date.parse(fact.validTo) < Date.parse(fact.validFrom)) throw new MemoryStoreError('bad_request', `fact ${fact.id} cannot end before it began`);
    this.claim('facts', fact.embedding);
    this.facts.set(fact.id, { fact: { ...fact, embedding: null }, embedding: fact.embedding ?? existing?.embedding ?? null, expiredAt: existing?.expiredAt ?? null });
  }

  async supersedeFact(id: string, validTo: string): Promise<void> {
    this.calls.push('supersedeFact');
    const stored = this.facts.get(id);
    if (stored === undefined) throw new MemoryStoreError('not_found', `no fact with id ${id}`);
    // The table's own CHECK (`facts_validity`, migration 0002): an interval cannot end before it starts.
    if (Date.parse(validTo) < Date.parse(stored.fact.validFrom)) throw new MemoryStoreError('bad_request', `fact ${id} cannot end (${validTo}) before it began (${stored.fact.validFrom})`);
    stored.fact = { ...stored.fact, validTo };
  }

  async expireFact(id: string, at: string): Promise<void> {
    this.calls.push('expireFact');
    const stored = this.facts.get(id);
    if (stored === undefined) throw new MemoryStoreError('not_found', `no fact with id ${id}`);
    stored.expiredAt ??= at; // a retry cannot move the first expiry, as in the companion
  }

  async deleteFact(id: string): Promise<void> {
    this.calls.push('deleteFact');
    if (!this.facts.delete(id)) throw new MemoryStoreError('not_found', `no fact with id ${id}`);
  }

  async listEpisodes(characterId: string, before: string | null): Promise<MemoryEpisode[]> {
    this.calls.push('listEpisodes');
    return [...this.episodes.values()]
      .map(({ episode }) => episode)
      .filter((episode) => episode.characterId === characterId && (before === null || Date.parse(episode.at) < Date.parse(before)))
      .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, EPISODE_PAGE_SIZE);
  }

  async deleteEpisode(id: string): Promise<void> {
    this.calls.push('deleteEpisode');
    if (!this.episodes.delete(id)) throw new MemoryStoreError('not_found', `no episode with id ${id}`);
    // As the companion's `ON DELETE SET NULL`: a fact read from the turn stays, unlinked.
    for (const stored of this.facts.values()) if (stored.fact.sourceEpisodeId === id) stored.fact = { ...stored.fact, sourceEpisodeId: null };
  }

  async currentFacts(characterId: string): Promise<SemanticFact[]> {
    this.calls.push('currentFacts');
    return this.current(characterId).map(({ fact }) => fact);
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalBundle> {
    this.calls.push('retrieve');
    const query = words(request.query);
    const probe = request.queryEmbedding;
    const vectorSearch = vectorSearchOutcome(probe, this.active.get('turns'));
    const queryVector = vectorSearch === 'used' ? probe : null;

    const episodes = [...this.episodes.values()]
      .filter(({ episode }) => episode.characterId === request.characterId && episode.sessionId !== request.sessionId && (request.since === null || Date.parse(episode.at) >= Date.parse(request.since)))
      .map(({ episode, embedding }) => ({ row: episode, embedding }));
    const episodeHits = rankHits(episodes, query, episodeText, queryVector, request.limits.episodes);

    const activeFacts = this.active.get('facts');
    const factQueryVector = queryVector !== null && activeFacts !== undefined && sameModel(activeFacts, queryVector.model) ? queryVector : null;
    const facts = this.current(request.characterId).map(({ fact, embedding }) => ({ row: fact, embedding }));
    const factHits = rankHits(facts, query, factText, factQueryVector, request.limits.facts);

    return {
      episodes: episodeHits.map((episode) => ({ ...episode, embedding: null })),
      facts: factHits.map((fact) => ({ ...fact, embedding: null })),
      blocks: [...this.blocks.values()].filter((block) => block.characterId === request.characterId).toSorted((a, b) => a.name.localeCompare(b.name)),
      documents: [],
      vectorSearch,
      elapsedMs: 0,
    };
  }

  async readBlocks(characterId: string): Promise<SelfModelBlock[]> {
    return [...this.blocks.values()].filter((block) => block.characterId === characterId).toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async writeBlock(block: SelfModelBlock): Promise<void> {
    this.blocks.set(`${block.characterId}\u0000${block.name}`, block);
  }

  async savePlan(plan: PlanDocument): Promise<void> {
    const stored = this.plans.get(plan.id);
    const expected = stored === undefined ? 1 : stored.version + 1;
    if (plan.version !== expected) throw new MemoryStoreError('conflict', `plan ${plan.id} must be saved at version ${expected}`);
    this.plans.set(plan.id, plan);
  }

  async listPlans(characterId: string): Promise<PlanDocument[]> {
    return [...this.plans.values()].filter((plan) => plan.characterId === characterId).toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async listSchedules(characterId: string): Promise<Schedule[]> {
    return [...this.schedules.values()].filter((schedule) => schedule.characterId === characterId);
  }

  async saveSchedule(schedule: Schedule): Promise<void> {
    this.schedules.set(schedule.id, schedule);
  }

  async deleteSchedule(id: string): Promise<void> {
    this.schedules.delete(id);
  }

  private current(characterId: string): StoredFact[] {
    const now = this.now().getTime();
    return [...this.facts.values()].filter(({ fact, expiredAt }) => fact.characterId === characterId && isCurrentFact(expiredAt, fact.validTo, now));
  }

  /** The first model to write a collection becomes its active one (ADR-36). */
  private claim(collection: 'turns' | 'facts', embedding: Embedding | null | undefined): void {
    if (embedding !== null && embedding !== undefined && !this.active.has(collection)) this.active.set(collection, embedding.model);
  }
}
