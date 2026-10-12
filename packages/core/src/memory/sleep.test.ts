import type { LLMProvider, LlmRequest, LlmStreamChunk, SemanticFact } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { Cancellation } from '../cancellation';
import { FakeMemoryStore } from './fake-store';
import { MemoryKernel } from './kernel';
import { MERGE_MARKER, applyMerges, mergeBatches, mergeKey, parseMerges, plainObject, ruleMerges } from './sleep';

let next = 0;
function fact(subject: string, predicate: string, object: string, extra: Partial<SemanticFact> = {}): SemanticFact {
  next += 1;
  const at = `2026-09-${String(next).padStart(2, '0')}T00:00:00.000Z`;
  return { id: `f${next}`, characterId: 'alice', subject, predicate, object, confidence: 0.6, validFrom: at, validTo: null, recordedAt: at, sourceEpisodeId: null, embedding: null, ...extra };
}

describe('merging by rule (P6-T04, ADR-53)', () => {
  it('reads objects without case, punctuation or leading articles, and predicates by family', () => {
    expect(plainObject('The Jazz!')).toBe('jazz');
    expect(plainObject('a beagle called Biscuit')).toBe('beagle called biscuit');
    expect(mergeKey(fact('user', 'loves', 'Jazz.'))).toBe(mergeKey(fact('user', 'likes', 'jazz')));
    expect(mergeKey(fact('user', 'likes', 'jazz'))).not.toBe(mergeKey(fact('user', 'dislikes', 'jazz')));
    expect(mergeKey(fact('user', 'likes', 'jazz'))).not.toBe(mergeKey(fact('sister', 'likes', 'jazz')));
  });

  it('groups them, keeping the earliest, and never touches a follow-up', () => {
    const first = fact('user', 'likes', 'jazz');
    const again = fact('user', 'enjoys', 'Jazz');
    const other = fact('user', 'likes', 'Coltrane');
    const followA = fact('garden', 'follow_up_on', '2026-10-01: soil');
    const followB = fact('garden', 'follow_up_on', '2026-10-01: soil');
    expect(ruleMerges([first, again, other, followA, followB])).toEqual([{ keep: first.id, merge: [again.id] }]);
  });
});

describe('merging by the model', () => {
  const shown = new Set(['f1', 'f2', 'f3', 'f4']);

  it('takes only groups of ids it was shown, each id once', () => {
    expect(parseMerges('```json\n{"groups":[{"keep":"f1","merge":["f2"]}]}\n```', shown)).toEqual([{ keep: 'f1', merge: ['f2'] }]);
    expect(parseMerges('{"groups":[{"keep":"f1","merge":["f9"]},{"keep":"f3","merge":["f4","f4"]}]}', shown)).toEqual([{ keep: 'f3', merge: ['f4'] }]);
    expect(parseMerges('{"groups":[{"keep":"f1","merge":["f2"]},{"keep":"f2","merge":["f3"]}]}', shown)).toEqual([{ keep: 'f1', merge: ['f2'] }]);
    expect(parseMerges('{"groups":[{"keep":"f1","merge":["f1"]}]}', shown)).toEqual([]);
    expect(parseMerges('no json', shown)).toEqual([]);
  });

  it('asks per subject with two or more facts, in batches, follow-ups left out', () => {
    const facts = [fact('user', 'likes', 'a'), fact('user', 'likes', 'b'), fact('user', 'likes', 'c'), fact('dog', 'name', 'Biscuit'), fact('plan', 'follow_up_on', 'x'), fact('plan', 'follow_up_on', 'y')];
    expect(mergeBatches(facts, 2).map((batch) => [batch.subject, batch.facts.length])).toEqual([
      ['user', 2],
      ['user', 1],
    ]);
  });

  it('keeps one, reinforced and true from the earliest start, and expires the rest', () => {
    const kept = fact('user', 'likes', 'jazz', { confidence: 0.6, validFrom: '2026-09-10T00:00:00.000Z' });
    const merged = fact('user', 'favorite_music', 'jazz music', { confidence: 0.6, validFrom: '2026-08-01T00:00:00.000Z' });
    const writes = applyMerges([kept, merged], [{ keep: kept.id, merge: [merged.id] }], new Date('2026-10-12T00:00:00.000Z'));
    expect(writes.upserts).toEqual([{ ...kept, confidence: 0.84, validFrom: '2026-08-01T00:00:00.000Z' }]);
    expect(writes.expire).toEqual([{ id: merged.id, at: '2026-10-12T00:00:00.000Z' }]);
  });
});

/** Answers merge requests from a script, and records what it was asked. */
class MergeLLM implements LLMProvider {
  readonly id = 'merge-llm';
  readonly requests: LlmRequest[] = [];
  private readonly reply: (request: LlmRequest) => string;
  constructor(reply: (request: LlmRequest) => string) {
    this.reply = reply;
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    yield { type: 'text-delta', text: this.reply(request) };
    yield { type: 'finish', reason: 'stop', usage: null };
  }
}

async function seeded(facts: readonly SemanticFact[]): Promise<FakeMemoryStore> {
  const store = new FakeMemoryStore();
  for (const item of facts) await store.upsertFact(item);
  return store;
}

describe('MemoryKernel.sleep', () => {
  it('merges by rule, then by the model, then runs the old pass; reasoning off', async () => {
    const jazz = fact('user', 'likes', 'jazz');
    const loves = fact('user', 'loves', 'Jazz');
    const music = fact('user', 'favorite_music', 'jazz music');
    const dog = fact('user', 'has_pet', 'beagle called Biscuit');
    const store = await seeded([jazz, loves, music, dog]);
    const llm = new MergeLLM(() => JSON.stringify({ groups: [{ keep: jazz.id, merge: [music.id] }] }));
    const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: { llm, modelId: 'm' }, now: () => new Date('2026-10-12T00:00:00.000Z') });
    const report = await kernel.sleep();
    expect(report).toMatchObject({ before: 4, after: 2, mergedByRule: 1, mergedByModel: 1, stopped: false });
    expect((await store.currentFacts('alice')).map((item) => item.id).toSorted()).toEqual([jazz.id, dog.id].toSorted());
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.reasoning).toBe('off');
    expect(JSON.stringify(llm.requests[0]?.messages)).toContain(MERGE_MARKER);
    // The rule's merge was written before the model was asked: it saw three, not four.
    expect(JSON.stringify(llm.requests[0]?.messages)).not.toContain(loves.id);
  });

  it('ignores a merge naming a fact it was not shown, and carries on after a failed answer', async () => {
    const a = fact('user', 'likes', 'tea');
    const b = fact('user', 'drinks', 'tea daily');
    const c = fact('sister', 'lives_in', 'Montreal');
    const d = fact('sister', 'city', 'Montreal');
    const store = await seeded([a, b, c, d]);
    let calls = 0;
    const llm = new MergeLLM(() => {
      calls += 1;
      return calls === 1 ? `{"groups":[{"keep":"${c.id}","merge":["${a.id}"]}]}` : 'not json';
    });
    const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: { llm, modelId: 'm' } });
    const report = await kernel.sleep();
    expect(report.mergedByModel).toBe(0);
    expect(report.after).toBe(4);
  });

  it('stops between steps when woken, leaving what it wrote whole', async () => {
    const store = await seeded([fact('user', 'likes', 'jazz'), fact('user', 'loves', 'jazz'), fact('user', 'favorite_music', 'jazz music'), fact('sister', 'a', 'x'), fact('sister', 'b', 'y')]);
    const wake = new Cancellation();
    const llm = new MergeLLM(() => {
      wake.abort();
      return '{"groups":[]}';
    });
    const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: { llm, modelId: 'm' } });
    const report = await kernel.sleep({ signal: wake });
    expect(report.stopped).toBe(true);
    expect(report.mergedByRule).toBe(1);
    expect(report.consolidated).toBeNull();
    expect(llm.requests).toHaveLength(1);
  });

  it('without a model, still merges by rule and consolidates', async () => {
    const store = await seeded([fact('user', 'likes', 'jazz'), fact('user', 'enjoys', 'Jazz!')]);
    const report = await new MemoryKernel({ store, characterId: 'alice', extractor: null }).sleep();
    expect(report).toMatchObject({ before: 2, after: 1, mergedByRule: 1, mergedByModel: 0 });
  });
});
