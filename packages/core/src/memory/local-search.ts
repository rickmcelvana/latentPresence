import type { Embedding, EmbeddingModelRef, MemoryEpisode, SemanticFact } from '@latentpresence/protocol';

/**
 * The ranking `FakeMemoryStore` and `IndexedDbMemoryStore` share (P4-T04): word overlap,
 * cosine, "vector hits first, then keyword hits, deduplicated, limited", the active-model
 * rule, and the current-fact filter. Pure functions over plain arrays — no store, no I/O —
 * so a store only has to load its rows and hand them here; the two adapters cannot drift
 * on what "found" means, only on how they fetch the rows.
 */

export function sameModel(a: EmbeddingModelRef, b: EmbeddingModelRef): boolean {
  return a.provider === b.provider && a.model === b.model && a.dimensions === b.dimensions;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
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

export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

export function overlap(query: Set<string>, text: string): number {
  let hits = 0;
  for (const word of words(text)) if (query.has(word)) hits += 1;
  return hits;
}

/**
 * Which way `retrieve` decided to search, and why not vectors when it did not: null means
 * no query embedding at all; otherwise the active model for the collection (or none, or a
 * different one from the query's).
 */
export function vectorSearchOutcome(queryEmbedding: Embedding | null, active: EmbeddingModelRef | undefined): 'used' | 'no-query-embedding' | 'no-active-model' | 'other-model' {
  if (queryEmbedding === null) return 'no-query-embedding';
  if (active === undefined) return 'no-active-model';
  return sameModel(active, queryEmbedding.model) ? 'used' : 'other-model';
}

/** One row plus the embedding kept beside it, for ranking without exposing the vector itself. */
export interface Ranked<Row> {
  readonly row: Row;
  readonly embedding: Embedding | null;
}

/**
 * Vector hits first (nearest first, only rows on the query's model), then keyword hits by
 * word overlap, deduplicated by identity and limited — the rule every `retrieve` follows.
 */
export function rankHits<Row>(rows: readonly Ranked<Row>[], query: Set<string>, textOf: (row: Row) => string, queryVector: Embedding | null, limit: number): Row[] {
  const byVector =
    queryVector === null
      ? []
      : rows
          .filter(({ embedding }) => embedding !== null && sameModel(embedding.model, queryVector.model))
          .map((entry) => ({ entry, score: cosine(entry.embedding?.vector ?? [], queryVector.vector) }))
          .toSorted((a, b) => b.score - a.score)
          .map(({ entry }) => entry.row);
  const byWords = rows
    .map((entry) => ({ entry, score: overlap(query, textOf(entry.row)) }))
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score)
    .map(({ entry }) => entry.row);
  return [...new Set([...byVector.slice(0, limit), ...byWords])].slice(0, limit);
}

/** A fact still believed and still holding: not expired, and `validTo` unset or in the future. */
export function isCurrentFact(expiredAt: string | null, validTo: string | null, nowMs: number): boolean {
  return expiredAt === null && (validTo === null || Date.parse(validTo) > nowMs);
}

/** Text an episode is matched against by keyword search. */
export function episodeText(episode: MemoryEpisode): string {
  return episode.text;
}

/** Text a fact is matched against by keyword search — the companion's FULLTEXT covers the same three columns. */
export function factText(fact: SemanticFact): string {
  return `${fact.subject} ${fact.predicate} ${fact.object}`.replaceAll('_', ' ');
}
