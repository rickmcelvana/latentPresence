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

function sameModel(a: EmbeddingModelRef, b: EmbeddingModelRef): boolean {
  return a.provider === b.provider && a.model === b.model && a.dimensions === b.dimensions;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

function overlap(query: Set<string>, text: string): number {
  let hits = 0;
  for (const word of words(text)) if (query.has(word)) hits += 1;
  return hits;
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
    if (fact.validTo !== null && fact.validTo < fact.validFrom) throw new Error(`fact ${fact.id} cannot end before it began`);
    this.claim('facts', fact.embedding);
    this.facts.set(fact.id, { fact: { ...fact, embedding: null }, embedding: fact.embedding ?? existing?.embedding ?? null, expiredAt: existing?.expiredAt ?? null });
  }

  async supersedeFact(id: string, validTo: string): Promise<void> {
    this.calls.push('supersedeFact');
    const stored = this.facts.get(id);
    if (stored === undefined) throw new Error(`no fact with id ${id}`);
    // The table's own CHECK (`facts_validity`, migration 0002): an interval cannot end before it starts.
    if (validTo < stored.fact.validFrom) throw new Error(`fact ${id} cannot end (${validTo}) before it began (${stored.fact.validFrom})`);
    stored.fact = { ...stored.fact, validTo };
  }

  async expireFact(id: string, at: string): Promise<void> {
    this.calls.push('expireFact');
    const stored = this.facts.get(id);
    if (stored === undefined) throw new Error(`no fact with id ${id}`);
    stored.expiredAt = at;
  }

  async currentFacts(characterId: string): Promise<SemanticFact[]> {
    this.calls.push('currentFacts');
    return this.current(characterId).map(({ fact }) => fact);
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalBundle> {
    this.calls.push('retrieve');
    const query = words(request.query);
    const probe = request.queryEmbedding;
    const activeTurns = this.active.get('turns');
    const vectorSearch: RetrievalBundle['vectorSearch'] =
      probe === null ? 'no-query-embedding' : activeTurns === undefined ? 'no-active-model' : sameModel(activeTurns, probe.model) ? 'used' : 'other-model';

    const episodes = [...this.episodes.values()].filter(
      ({ episode }) => episode.characterId === request.characterId && episode.sessionId !== request.sessionId && (request.since === null || episode.at >= request.since),
    );
    const byVector =
      vectorSearch === 'used' && probe !== null
        ? episodes
            .filter(({ embedding }) => embedding !== null && sameModel(embedding.model, probe.model))
            .map((row) => ({ row, score: cosine(row.embedding?.vector ?? [], probe.vector) }))
            .toSorted((a, b) => b.score - a.score)
            .map(({ row }) => row)
        : [];
    const byWords = episodes
      .map((row) => ({ row, score: overlap(query, row.episode.text) }))
      .filter(({ score }) => score > 0)
      .toSorted((a, b) => b.score - a.score)
      .map(({ row }) => row);
    const episodeHits = [...new Set([...byVector.slice(0, request.limits.episodes), ...byWords])].slice(0, request.limits.episodes);

    const facts = this.current(request.characterId);
    const activeFacts = this.active.get('facts');
    const factsByVector =
      vectorSearch === 'used' && probe !== null && activeFacts !== undefined && sameModel(activeFacts, probe.model)
        ? facts
            .filter(({ embedding }) => embedding !== null && sameModel(embedding.model, probe.model))
            .map((row) => ({ row, score: cosine(row.embedding?.vector ?? [], probe.vector) }))
            .toSorted((a, b) => b.score - a.score)
            .map(({ row }) => row)
        : [];
    const factsByWords = facts
      .map((row) => ({ row, score: overlap(query, `${row.fact.subject} ${row.fact.predicate} ${row.fact.object}`.replaceAll('_', ' ')) }))
      .filter(({ score }) => score > 0)
      .toSorted((a, b) => b.score - a.score)
      .map(({ row }) => row);
    const factHits = [...new Set([...factsByVector.slice(0, request.limits.facts), ...factsByWords])].slice(0, request.limits.facts);

    return {
      episodes: episodeHits.map(({ episode }) => ({ ...episode, embedding: null })),
      facts: factHits.map(({ fact }) => ({ ...fact, embedding: null })),
      blocks: [...this.blocks.values()].filter((block) => block.characterId === request.characterId).toSorted((a, b) => a.name.localeCompare(b.name)),
      documents: [],
      vectorSearch,
      elapsedMs: 0,
    };
  }

  async readBlocks(characterId: string): Promise<SelfModelBlock[]> {
    return [...this.blocks.values()].filter((block) => block.characterId === characterId);
  }

  async writeBlock(block: SelfModelBlock): Promise<void> {
    this.blocks.set(`${block.characterId}\u0000${block.name}`, block);
  }

  async savePlan(plan: PlanDocument): Promise<void> {
    const stored = this.plans.get(plan.id);
    const expected = stored === undefined ? 1 : stored.version + 1;
    if (plan.version !== expected) throw new Error(`conflict: plan ${plan.id} must be saved at version ${expected}`);
    this.plans.set(plan.id, plan);
  }

  async listPlans(characterId: string): Promise<PlanDocument[]> {
    return [...this.plans.values()].filter((plan) => plan.characterId === characterId);
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
    const now = this.now().toISOString();
    return [...this.facts.values()].filter(({ fact, expiredAt }) => fact.characterId === characterId && expiredAt === null && (fact.validTo === null || fact.validTo > now));
  }

  /** The first model to write a collection becomes its active one (ADR-36). */
  private claim(collection: 'turns' | 'facts', embedding: Embedding | null | undefined): void {
    if (embedding !== null && embedding !== undefined && !this.active.has(collection)) this.active.set(collection, embedding.model);
  }
}
