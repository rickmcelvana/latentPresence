import { describe, expect, it } from 'vitest';
import type { SemanticFact } from '@latentpresence/protocol';
import { consolidateFacts } from './consolidate';

const NOW = new Date('2026-12-01T00:00:00.000Z');

function fact(id: string, predicate: string, object: string, extra: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id,
    characterId: 'alice',
    subject: 'user',
    predicate,
    object,
    confidence: 0.9,
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-09-01T00:00:00.000Z',
    sourceEpisodeId: null,
    embedding: null,
    ...extra,
  };
}

describe('consolidateFacts', () => {
  it('merges duplicates into the earliest record and expires the copies', () => {
    const plan = consolidateFacts(
      [fact('a', 'likes', 'Thai food', { confidence: 0.6 }), fact('b', 'likes', 'thai food', { confidence: 0.6, recordedAt: '2026-09-05T00:00:00.000Z' })],
      NOW,
    );
    expect(plan.upserts).toEqual([expect.objectContaining({ id: 'a', confidence: expect.closeTo(0.84, 5) })]);
    expect(plan.expire).toEqual([{ id: 'b', at: NOW.toISOString() }]);
    expect(plan.supersede).toEqual([]);
  });

  it('keeps the latest value of a single-valued predicate and supersedes the rest where it began', () => {
    const plan = consolidateFacts([fact('toronto', 'lives_in', 'Toronto'), fact('halifax', 'lives_in', 'Halifax', { validFrom: '2026-09-24T00:00:00.000Z' })], NOW);
    expect(plan.supersede).toEqual([{ id: 'toronto', validTo: '2026-09-24T00:00:00.000Z' }]);
    expect(plan.expire).toEqual([]);
  });

  it('forgets an old, unconfirmed, doubtful fact by expiring it — and nothing else', () => {
    const plan = consolidateFacts(
      [
        fact('old-doubt', 'likes', 'jazz', { confidence: 0.3 }),
        fact('new-doubt', 'likes', 'opera', { confidence: 0.3, recordedAt: '2026-11-25T00:00:00.000Z' }),
        fact('old-sure', 'likes', 'running', { confidence: 0.9 }),
      ],
      NOW,
    );
    expect(plan.expire).toEqual([{ id: 'old-doubt', at: NOW.toISOString() }]);
    expect(plan.upserts).toEqual([]);
  });

  it('changes nothing when there is nothing to change', () => {
    expect(consolidateFacts([fact('a', 'name', 'Jordan'), fact('b', 'likes', 'running')], NOW)).toEqual({ upserts: [], expire: [], supersede: [] });
  });

  it('keeps characters apart: the same fact for two characters is not a duplicate', () => {
    const plan = consolidateFacts([fact('a', 'likes', 'running'), fact('b', 'likes', 'running', { characterId: 'bob' })], NOW);
    expect(plan.expire).toEqual([]);
  });
});
