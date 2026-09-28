import { describe, expect, it } from 'vitest';
import type { SemanticFact } from '@latentpresence/protocol';
import { canonicalTerm, planFactWrites, reinforce, type ExtractedFact } from './facts';

const NOW = '2026-09-24T12:00:00.000Z';

function known(id: string, subject: string, predicate: string, object: string, extra: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id,
    characterId: 'alice',
    subject,
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

function heard(subject: string, predicate: string, object: string, extra: Partial<ExtractedFact> = {}): ExtractedFact {
  return { subject, predicate, object, confidence: 0.9, validFrom: null, replaces: null, ...extra };
}

function plan(facts: readonly SemanticFact[], extracted: readonly ExtractedFact[], ended: readonly string[] = []) {
  let next = 0;
  return planFactWrites(
    facts,
    extracted,
    {
      characterId: 'alice',
      now: NOW,
      newId: () => {
        next += 1;
        return `new-${next}`;
      },
      sourceEpisodeId: 'turn-1',
    },
    ended,
  );
}

describe('planFactWrites', () => {
  it('writes a new fact in canonical form, from now, with where it came from', () => {
    const { upserts, supersede, expire } = plan([], [heard('User', 'Lives In', ' Halifax ')]);
    expect(upserts).toEqual([expect.objectContaining({ id: 'new-1', subject: 'user', predicate: 'lives_in', object: 'Halifax', validFrom: NOW, recordedAt: NOW, sourceEpisodeId: 'turn-1' })]);
    expect(supersede).toEqual([]);
    expect(expire).toEqual([]);
  });

  it('reinforces a fact heard again instead of writing a second one', () => {
    const { upserts } = plan([known('f1', 'user', 'likes', 'Thai food')], [heard('user', 'likes', 'thai food', { confidence: 0.6 })]);
    expect(upserts).toEqual([expect.objectContaining({ id: 'f1', confidence: reinforce(0.9, 0.6) })]);
  });

  it('closes the old value of a single-valued predicate where the new one starts', () => {
    const { upserts, supersede } = plan([known('toronto', 'user', 'lives_in', 'Toronto')], [heard('user', 'lives_in', 'Halifax')]);
    expect(supersede).toEqual([{ id: 'toronto', validTo: NOW }]);
    expect(upserts.map((fact) => fact.object)).toEqual(['Halifax']);
  });

  it('keeps several values of a multi-valued predicate', () => {
    const { supersede } = plan([known('f1', 'user', 'likes', 'running')], [heard('user', 'likes', 'knitting')]);
    expect(supersede).toEqual([]);
  });

  it('closes what `replaces` names even when the predicate is multi-valued', () => {
    const { supersede } = plan([known('peanuts', 'user', 'allergic_to', 'peanuts')], [heard('user', 'allergic_to', 'tree nuts', { replaces: 'peanuts' })]);
    expect(supersede).toEqual([{ id: 'peanuts', validTo: NOW }]);
  });

  it('expires a fact replaced before it began: it was never true', () => {
    const october = known('general', 'user', 'works_at', 'Toronto General', { validFrom: '2026-10-01T00:00:00.000Z' });
    const { supersede, expire } = plan([october], [heard('user', 'works_at', 'QEII')]);
    expect(supersede).toEqual([]);
    expect(expire).toEqual([{ id: 'general', at: NOW }]);
  });

  it('keeps a fact heard and replaced in one exchange, closed', () => {
    const { upserts, supersede } = plan([], [heard('user', 'lives_in', 'Toronto', { validFrom: '2026-01-01T00:00:00.000Z' }), heard('user', 'lives_in', 'Halifax')]);
    expect(supersede).toEqual([]);
    expect(upserts.map((fact) => [fact.object, fact.validTo])).toEqual([
      ['Toronto', NOW],
      ['Halifax', null],
    ]);
  });

  it('moves a restated fact to its earlier start and ends its single-valued rival then', () => {
    const nights = known('nights', 'user', 'work_schedule', 'night shifts', { validTo: '2026-10-01T00:00:00.000Z' });
    const days = known('days', 'user', 'work_schedule', 'day shifts', { validFrom: '2026-10-01T00:00:00.000Z' });
    const { upserts, supersede } = plan([nights, days], [heard('user', 'work_schedule', 'day shifts')]);
    expect(upserts).toEqual([expect.objectContaining({ id: 'days', validFrom: NOW })]);
    expect(supersede).toEqual([{ id: 'nights', validTo: NOW }]);
  });

  it('ends a known fact with nothing in its place, and ignores ids it does not know', () => {
    const { supersede, upserts } = plan([known('marathon', 'user', 'plans_to', 'run a half marathon')], [], ['marathon', 'invented-by-the-model']);
    expect(supersede).toEqual([{ id: 'marathon', validTo: NOW }]);
    expect(upserts).toEqual([]);
  });

  it('never touches another character’s facts', () => {
    const bobs = known('bob-toronto', 'user', 'lives_in', 'Toronto', { characterId: 'bob' });
    const { supersede, upserts } = plan([bobs], [heard('user', 'lives_in', 'Halifax')]);
    expect(supersede).toEqual([]);
    expect(upserts.every((fact) => fact.characterId === 'alice')).toBe(true);
  });

  it('drops an entry with nothing in it', () => {
    expect(plan([], [heard(' ', 'likes', 'x'), heard('user', 'likes', '  ')]).upserts).toEqual([]);
  });
});

describe('canonicalTerm and reinforce', () => {
  it('turns any spelling into snake_case', () => {
    expect(canonicalTerm(' Dog Biscuit ')).toBe('dog_biscuit');
    expect(canonicalTerm('lives-in')).toBe('lives_in');
  });

  it('combines confidences as independent witnesses, never past 1', () => {
    expect(reinforce(0.5, 0.5)).toBeCloseTo(0.75);
    expect(reinforce(1, 0.9)).toBe(1);
  });
});
