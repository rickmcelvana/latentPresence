import type { LLMProvider, SemanticFact } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from './fake-store';
import { FORGETFUL_WRITES, LIFE, LONG_REPLAY, NEW_LATE, topicCounts } from './fixtures/long-replay';
import { LONG_MERGE_MODEL, LONG_MERGE_REPLIES } from './fixtures/long-replay.recording';
import { ForgetfulExtractor, RecordedLLM, replayEvenings } from './fixtures/replay';

/**
 * P6-T04's done-when: over a long transcript replay the fact count grows sublinearly, and
 * duplicates merge. Sam's twelve evenings (about twenty things retold in other words), extracted
 * by an extractor that ignores the known facts — the case that makes duplicates — and slept on
 * after each evening, the merges answered by the model's recorded replies
 * (`FORGETFUL=1 pnpm live:sleep`).
 */

const NO_MODEL: LLMProvider = {
  id: 'no-model',
  async listModels() {
    return [];
  },
  // oxlint-disable-next-line require-yield
  async *stream() {
    throw new Error('no model here');
  },
};

async function replay(sleep: boolean, merges: LLMProvider = new RecordedLLM(LONG_MERGE_REPLIES)) {
  return replayEvenings({ store: new FakeMemoryStore(), llm: new ForgetfulExtractor(FORGETFUL_WRITES, merges), modelId: LONG_MERGE_MODEL, exchanges: LONG_REPLAY, sleep });
}

/** How many current facts have `word` in their object. */
function about(facts: readonly SemanticFact[], word: RegExp): number {
  return facts.filter((fact) => word.test(fact.object)).length;
}

/** Facts added per exchange over the first and the second half of the evenings. */
function rates(counts: readonly { readonly exchanges: number; readonly facts: number }[]): { first: number; second: number } {
  const mid = counts[Math.floor(counts.length / 2) - 1];
  const end = counts.at(-1);
  if (mid === undefined || end === undefined) throw new Error('no evenings');
  return { first: mid.facts / mid.exchanges, second: (end.facts - mid.facts) / (end.exchanges - mid.exchanges) };
}

describe('the long replay (P6-T04, ADR-53)', () => {
  it('is long, and every line of it says something the forgetful extractor can write', () => {
    expect(LONG_REPLAY.length).toBeGreaterThan(100);
    for (const topic of LIFE) expect(topic.writes, topic.id).toHaveLength(topic.lines.length);
  });

  it('with sleep, the fact count grows sublinearly: the second half adds facts at under half the rate of the first', async () => {
    const { counts, errors } = await replay(true);
    expect(errors).toEqual([]);
    const { first, second } = rates(counts);
    expect(second).toBeLessThan(first / 2);
    // What is left is what is new: one fact per thing in Sam's life, and the late news.
    expect(counts.at(-1)?.facts).toBe(LIFE.length + NEW_LATE.length);
  });

  it('merges every rewording: each thing in Sam\'s life ends as exactly one fact, and nothing new is lost', async () => {
    const { current } = await replay(true);
    expect(topicCounts(current)).toEqual(Object.fromEntries(LIFE.map((topic) => [topic.id, 1])));
    for (const late of NEW_LATE) expect(current.some((fact) => fact.object === late.writes[2]), late.line).toBe(true);
  });

  it('without sleep, the same extractions keep the rewordings side by side — eight more facts that say nothing new', async () => {
    const { counts, current } = await replay(false, NO_MODEL);
    const slept = await replay(true);
    expect(counts.at(-1)!.facts).toBe(slept.counts.at(-1)!.facts + 8);
    expect(about(current, /jazz/iu)).toBeGreaterThan(1);
    expect(about(current, /biscuit/iu)).toBeGreaterThan(1);
    expect(about(slept.current, /jazz/iu)).toBe(1);
    expect(about(slept.current, /biscuit/iu)).toBe(1);
  });

  it('by rule alone (a model that merges nothing), the plain rewordings still go', async () => {
    const nothing = new RecordedLLM(LONG_MERGE_REPLIES.map(() => '{"groups":[]}'));
    const { current } = await replay(true, nothing);
    const withoutSleep = await replay(false, NO_MODEL);
    expect(current.length).toBeLessThan(withoutSleep.current.length);
    const counts = topicCounts(current);
    // "likes jazz", "loves Jazz", "is_into jazz" are one by rule; "favorite_music jazz" needs the model.
    expect(counts.jazz).toBe(2);
    expect(counts.winter).toBe(1);
    expect(counts.hometown).toBe(1);
  });
});
