import type { MemoryEpisode, RetrievalBundle, SelfModelBlock, SemanticFact, UserAffect } from '@latentpresence/protocol';

/**
 * What she remembers for this turn (P4-T03): the store's one answer (ADR-17), re-ranked by
 * three things and cut to what a prompt can carry.
 *
 * - **relevance** — the store's own order: vector hits nearest first, then keyword hits by
 *   FULLTEXT relevance (P4-T02). The bundle carries no distances, so a hit's relevance is its
 *   place in that order;
 * - **recency** — halving with age: a turn over `episodeHalfLifeDays`, a fact far more slowly
 *   (a fact is still true next year; last month's conversation is fading);
 * - **importance** — a fact's confidence; a turn's emotional salience, from the fused
 *   `UserAffect` stored with it (P3-T07): the things someone said while upset or delighted
 *   are the ones a friend remembers.
 *
 * The store is asked for more than the prompt takes (`fetchFactor`), so the re-ranking has
 * something to choose from.
 */

export interface RecallParams {
  readonly weights: { readonly relevance: number; readonly recency: number; readonly importance: number };
  readonly episodeHalfLifeDays: number;
  readonly factHalfLifeDays: number;
  readonly maxEpisodes: number;
  readonly maxFacts: number;
  /** How many more than `max*` to ask the store for. */
  readonly fetchFactor: number;
}

export const DEFAULT_RECALL_PARAMS: RecallParams = {
  weights: { relevance: 0.6, recency: 0.25, importance: 0.15 },
  episodeHalfLifeDays: 14,
  factHalfLifeDays: 365,
  maxEpisodes: 4,
  maxFacts: 12,
  fetchFactor: 2,
};

export interface MemoryContext {
  readonly facts: readonly SemanticFact[];
  readonly episodes: readonly MemoryEpisode[];
  readonly blocks: readonly SelfModelBlock[];
  readonly vectorSearch: RetrievalBundle['vectorSearch'];
  readonly elapsedMs: number;
}

const DAY_MS = 86_400_000;

function recency(at: string, now: number, halfLifeDays: number): number {
  const age = Math.max(0, now - Date.parse(at));
  return 0.5 ** (age / (halfLifeDays * DAY_MS));
}

/** How much a turn stood out, from the affect fused at the time; 0 when none was measured. */
export function salience(affect: UserAffect | null): number {
  if (affect === null) return 0;
  return Math.min(1, affect.confidence * Math.max(Math.abs(affect.valence), Math.abs(affect.arousal)));
}

/** A hit's place in the store's own order, as 1 for the first down towards 0. */
function relevance(index: number, count: number): number {
  return count <= 1 ? 1 : 1 - index / count;
}

function ranked<T>(items: readonly T[], score: (item: T, index: number) => number, keep: number): T[] {
  return items
    .map((item, index) => ({ item, score: score(item, index), index }))
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, keep)
    .map(({ item }) => item);
}

export function rankRecall(bundle: RetrievalBundle, now: Date, params: RecallParams = DEFAULT_RECALL_PARAMS): MemoryContext {
  const at = now.getTime();
  const { weights } = params;
  const episodes = ranked(
    bundle.episodes,
    (episode, index) =>
      weights.relevance * relevance(index, bundle.episodes.length) +
      weights.recency * recency(episode.at, at, params.episodeHalfLifeDays) +
      weights.importance * salience(episode.affect),
    params.maxEpisodes,
  );
  const facts = ranked(
    bundle.facts,
    (fact, index) =>
      weights.relevance * relevance(index, bundle.facts.length) +
      weights.recency * recency(fact.recordedAt, at, params.factHalfLifeDays) +
      weights.importance * fact.confidence,
    params.maxFacts,
  );
  return { facts, episodes, blocks: bundle.blocks, vectorSearch: bundle.vectorSearch, elapsedMs: bundle.elapsedMs };
}

function when(at: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(at)) / DAY_MS);
  if (days <= 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `on ${at.slice(0, 10)}`;
}

/** A fact as a line: "user lives in Halifax (since 2026-08-01)". */
export function factLine(fact: SemanticFact): string {
  const since = fact.validFrom.slice(0, 10) === fact.recordedAt.slice(0, 10) ? '' : ` (since ${fact.validFrom.slice(0, 10)})`;
  const hedge = fact.confidence < 0.5 ? ' (not sure)' : '';
  return `${fact.subject.replaceAll('_', ' ')} ${fact.predicate.replaceAll('_', ' ')} ${fact.object}${since}${hedge}`;
}

/**
 * The context as prompt text, or an empty string when there is nothing to say. Blocks are
 * not rendered here: they are the character's own notes and belong beside the persona.
 */
export function renderMemory(context: MemoryContext, now: Date): string {
  const lines: string[] = [];
  if (context.facts.length > 0) {
    lines.push('What you know about them:', ...context.facts.map((fact) => `- ${factLine(fact)}`));
  }
  if (context.episodes.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      'Earlier conversations that may matter now:',
      ...context.episodes.map((episode) => `- ${when(episode.at, now)}, ${episode.role === 'user' ? 'they said' : 'you said'}: "${episode.text}"`),
    );
  }
  return lines.join('\n');
}
