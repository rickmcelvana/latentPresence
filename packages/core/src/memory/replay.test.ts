import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from './fake-store';
import { RecordedLLM, replayConversation } from './fixtures/replay';
import { RECORDED_MODEL, RECORDED_REPLIES } from './fixtures/thirty-turns.recording';
import { EXPECTED_CLOSED, EXPECTED_CURRENT, scoreFacts, THIRTY_TURNS } from './fixtures/thirty-turns';

/**
 * P4-T03's done-when: a replay of thirty turns yields the expected fact set. The model's
 * replies were recorded by `pnpm live:memory` (glm-5.2:cloud) and are played back here, so
 * the kernel's own logic — reinforcing, superseding, expiring, ending — is what is tested,
 * against the same conversation and expectations the live check scores.
 */
async function replay() {
  const store = new FakeMemoryStore({ now: () => new Date('2026-09-25T00:00:00Z') });
  const llm = new RecordedLLM(RECORDED_REPLIES);
  const result = await replayConversation({ store, llm, modelId: RECORDED_MODEL });
  return { ...result, store, llm };
}

describe('the thirty-turn replay (P4-T03)', () => {
  it('asks for one extraction per exchange and uses every recorded reply', async () => {
    const { llm, errors } = await replay();
    expect(llm.requests).toHaveLength(THIRTY_TURNS.length);
    expect(RECORDED_REPLIES).toHaveLength(THIRTY_TURNS.length);
    expect(errors).toEqual([]);
    // Extraction is a background call: never reasoning first (ADR-37).
    expect(llm.requests.every((request) => request.reasoning === 'off')).toBe(true);
  });

  it('ends believing every expected fact and none of the replaced ones', async () => {
    const { current } = await replay();
    const score = scoreFacts(current);
    expect(score.missing).toEqual([]);
    expect(score.stale).toEqual([]);
    expect(EXPECTED_CURRENT.length).toBeGreaterThan(10);
    expect(EXPECTED_CLOSED.length).toBeGreaterThan(4);
  });

  it('keeps what it stopped believing, closed rather than deleted', async () => {
    const { store } = await replay();
    const closed = store.rows.facts.filter((row) => row.fact.validTo !== null || row.expiredAt !== null).map((row) => `${row.fact.subject} ${row.fact.predicate} ${row.fact.object}`);
    expect(closed.some((line) => /lives_in toronto/i.test(line))).toBe(true);
    expect(closed.some((line) => /allergic_to peanuts/i.test(line))).toBe(true);
  });

  it('is deterministic: the same recording gives the same facts, with the same ids', async () => {
    const first = await replay();
    const second = await replay();
    expect(second.current).toEqual(first.current);
    expect(first.current.map((fact) => `${fact.id} ${fact.subject} ${fact.predicate} ${fact.object} ${fact.validFrom.slice(0, 10)}`)).toMatchSnapshot();
  });
});
