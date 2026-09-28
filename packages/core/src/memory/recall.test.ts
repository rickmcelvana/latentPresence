import { describe, expect, it } from 'vitest';
import type { MemoryEpisode, RetrievalBundle, SemanticFact, UserAffect } from '@latentpresence/protocol';
import { DEFAULT_RECALL_PARAMS, factLine, rankRecall, renderMemory, salience } from './recall';

const NOW = new Date('2026-09-28T12:00:00.000Z');

function episode(id: string, at: string, affect: UserAffect | null = null): MemoryEpisode {
  return { id, sessionId: 's', characterId: 'alice', role: 'user', text: `said ${id}`, interrupted: false, at, embedding: null, affect };
}

function fact(id: string, confidence: number, recordedAt = '2026-09-20T00:00:00.000Z'): SemanticFact {
  return { id, characterId: 'alice', subject: 'user', predicate: 'likes', object: id, confidence, validFrom: recordedAt, validTo: null, recordedAt, sourceEpisodeId: null, embedding: null };
}

function bundle(episodes: MemoryEpisode[], facts: SemanticFact[] = []): RetrievalBundle {
  return { episodes, facts, blocks: [], documents: [], vectorSearch: 'used', elapsedMs: 3 };
}

const upset: UserAffect = { label: 'sad', valence: -0.8, arousal: -0.2, confidence: 0.9, readings: [], at: NOW.toISOString() };

describe('rankRecall', () => {
  it('prefers the store’s best match, then what is recent', () => {
    const context = rankRecall(bundle([episode('old-best', '2026-06-01T00:00:00Z'), episode('recent', '2026-09-27T00:00:00Z'), episode('old', '2026-06-01T00:00:00Z')]), NOW, { ...DEFAULT_RECALL_PARAMS, maxEpisodes: 2 });
    expect(context.episodes.map((e) => e.id)).toEqual(['recent', 'old-best']);
  });

  it('lets an emotional moment outrank an ordinary one of the same age and relevance', () => {
    const context = rankRecall(bundle([episode('plain', '2026-09-20T00:00:00Z'), episode('upset', '2026-09-20T00:00:00Z', upset)]), NOW, { ...DEFAULT_RECALL_PARAMS, weights: { relevance: 0, recency: 0.5, importance: 0.5 } });
    expect(context.episodes[0]?.id).toBe('upset');
  });

  it('prefers a sure fact to a doubtful one, all else equal', () => {
    const context = rankRecall(bundle([], [fact('doubtful', 0.4), fact('sure', 0.9)]), NOW, { ...DEFAULT_RECALL_PARAMS, weights: { relevance: 0, recency: 0, importance: 1 } });
    expect(context.facts.map((f) => f.id)).toEqual(['sure', 'doubtful']);
  });

  it('passes through what the store said about the search', () => {
    const context = rankRecall({ ...bundle([]), vectorSearch: 'other-model', elapsedMs: 9 }, NOW);
    expect(context.vectorSearch).toBe('other-model');
    expect(context.elapsedMs).toBe(9);
  });
});

describe('salience', () => {
  it('is nothing without a reading, and strong for a confident, strong feeling', () => {
    expect(salience(null)).toBe(0);
    expect(salience(upset)).toBeCloseTo(0.72);
  });
});

describe('renderMemory', () => {
  it('says what she knows and what was said, in plain lines', () => {
    const text = renderMemory(
      { facts: [fact('Thai food', 0.9), fact('jazz', 0.4)], episodes: [episode('x', '2026-09-26T12:00:00Z')], blocks: [], vectorSearch: 'used', elapsedMs: 1 },
      NOW,
    );
    expect(text).toContain('What you know about them:\n- user likes Thai food');
    expect(text).toContain('- user likes jazz (not sure)');
    expect(text).toContain('- 2 days ago, they said: "said x"');
  });

  it('is empty when there is nothing to say', () => {
    expect(renderMemory({ facts: [], episodes: [], blocks: [], vectorSearch: 'no-query-embedding', elapsedMs: 0 }, NOW)).toBe('');
  });

  it('gives a start date only when it differs from when it was learned', () => {
    expect(factLine({ ...fact('Halifax', 0.9), predicate: 'lives_in', validFrom: '2026-08-01T00:00:00Z' })).toBe('user lives in Halifax (since 2026-08-01)');
  });
});
