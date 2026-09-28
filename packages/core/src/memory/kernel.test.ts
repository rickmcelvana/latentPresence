import { describe, expect, it } from 'vitest';
import type { EmbeddingCapabilities, EmbeddingModelRef, EmbeddingProvider, LLMProvider, LlmRequest, LlmStreamChunk, SemanticFact } from '@latentpresence/protocol';
import { deferred } from '../testing/scripted';
import { FakeMemoryStore } from './fake-store';
import { MemoryKernel, type MemoryTurn } from './kernel';

const NOW = new Date('2026-09-28T12:00:00.000Z');

/** Answers each extraction with the next reply; `gate` holds the first answer back. */
class RepliesLLM implements LLMProvider {
  readonly id = 'replies';
  readonly requests: LlmRequest[] = [];
  private readonly replies: string[];
  private readonly gate: Promise<void> | undefined;
  constructor(replies: string[], gate?: Promise<void>) {
    this.replies = replies;
    this.gate = gate;
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    if (this.requests.length === 1 && this.gate !== undefined) await this.gate;
    const reply = this.replies.shift();
    if (reply === 'THROW') throw new Error('model down');
    yield { type: 'text-delta', text: reply ?? '{"facts":[]}' };
    yield { type: 'finish', reason: 'stop', usage: null };
  }
}

/** Bag of words hashed into 16 dimensions: similar sentences are near, as a real model's are. */
class WordsEmbedder implements EmbeddingProvider {
  readonly id = 'words';
  calls = 0;
  async capabilities(): Promise<EmbeddingCapabilities> {
    return { dimensions: 16, maxBatch: 64, normalized: false, runsInBrowser: true };
  }
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((text) => {
      const vector = Array.from({ length: 16 }, () => 0);
      for (const word of text.toLowerCase().split(/\W+/).filter((w) => w.length > 2)) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 16;
        vector[hash] = (vector[hash] ?? 0) + 1;
      }
      return vector;
    });
  }
}

const MODEL: EmbeddingModelRef = { provider: 'test', model: 'words', dimensions: 16 };

function turn(id: string, role: 'user' | 'assistant', text: string, sessionId = 's1'): MemoryTurn {
  return { id, sessionId, role, text, interrupted: false, at: NOW.toISOString(), affect: null };
}

function fact(json: object): string {
  return JSON.stringify({ facts: [{ confidence: 0.9, validFrom: null, replaces: null, ...json }], ended: [] });
}

function kernel(store: FakeMemoryStore, llm: LLMProvider | null, extra: Partial<ConstructorParameters<typeof MemoryKernel>[0]> = {}) {
  const errors: string[] = [];
  let next = 0;
  const built = new MemoryKernel({
    store,
    characterId: 'alice',
    extractor: llm === null ? null : { llm, modelId: 'm' },
    now: () => NOW,
    newId: () => `f${(next += 1)}`,
    onError: (error, stage) => errors.push(`${stage}: ${error.message}`),
    ...extra,
  });
  return { kernel: built, errors };
}

describe('MemoryKernel — writing', () => {
  it('returns at once and writes behind: remembering never waits for the model', async () => {
    const gate = deferred();
    const store = new FakeMemoryStore({ now: () => NOW });
    const { kernel: k } = kernel(store, new RepliesLLM([fact({ subject: 'user', predicate: 'lives_in', object: 'Halifax' })], gate.promise));
    k.remember(turn('t1', 'user', 'I live in Halifax.'));
    k.remember(turn('t2', 'assistant', 'Lovely city.'));
    // Nothing has been written yet, and the caller already has control back.
    expect(store.rows.facts).toEqual([]);
    gate.resolve();
    await k.idle();
    expect(store.rows.episodes.map((row) => row.episode.id)).toEqual(['t1', 't2']);
    expect(await store.currentFacts('alice')).toEqual([expect.objectContaining({ subject: 'user', predicate: 'lives_in', object: 'Halifax', sourceEpisodeId: 't1' })]);
  });

  it('reads an exchange once the character has answered, with every user line since the last one', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const llm = new RepliesLLM([]);
    const { kernel: k } = kernel(store, llm);
    k.remember(turn('t1', 'user', 'First thing.'));
    k.remember(turn('t2', 'user', 'Second thing.'));
    await k.idle();
    expect(llm.requests).toHaveLength(0);
    k.remember(turn('t3', 'assistant', 'I heard both.'));
    await k.idle();
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.messages[1]?.content).toContain('Person: First thing.\nPerson: Second thing.');
    expect(llm.requests[0]?.reasoning).toBe('off');
  });

  it('keeps going when the model or the store fails, and says so', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const { kernel: k, errors } = kernel(store, new RepliesLLM(['THROW', fact({ subject: 'user', predicate: 'name', object: 'Jordan' })]));
    k.remember(turn('t1', 'user', 'Hi.'));
    k.remember(turn('t2', 'assistant', 'Hello.'));
    k.remember(turn('t3', 'user', "I'm Jordan."));
    k.remember(turn('t4', 'assistant', 'Hi Jordan.'));
    await k.idle();
    expect(errors).toEqual(['extract: model down']);
    expect((await store.currentFacts('alice')).map((f) => f.object)).toEqual(['Jordan']);
  });

  it('with no extractor, keeps the turns and reads nothing from them', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const { kernel: k } = kernel(store, null);
    k.remember(turn('t1', 'user', 'I live in Halifax.'));
    k.remember(turn('t2', 'assistant', 'Nice.'));
    await k.idle();
    expect(store.rows.episodes).toHaveLength(2);
    expect(store.rows.facts).toEqual([]);
  });

  it('embeds turns and facts with its model when it has an embedder', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const { kernel: k } = kernel(store, new RepliesLLM([fact({ subject: 'user', predicate: 'has_pet', object: 'cat Miso' })]), { embedder: { provider: new WordsEmbedder(), model: MODEL } });
    k.remember(turn('t1', 'user', 'My cat is called Miso.'));
    k.remember(turn('t2', 'assistant', 'Hello Miso.'));
    await k.idle();
    expect(store.rows.episodes.every((row) => row.embedding?.model === MODEL && row.embedding.vector.length === 16)).toBe(true);
    expect(store.rows.facts[0]?.embedding?.model).toEqual(MODEL);
  });
});

describe('MemoryKernel — reading', () => {
  it('asks the store once per turn', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const { kernel: k } = kernel(store, null, { embedder: { provider: new WordsEmbedder(), model: MODEL } });
    const before = store.calls.length;
    await k.recall({ sessionId: 's2', query: 'how is the cat?' });
    expect(store.calls.slice(before)).toEqual(['retrieve']);
  });

  it('finds an earlier session by meaning when it can embed, and says the vectors were used', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const { kernel: k } = kernel(store, null, { embedder: { provider: new WordsEmbedder(), model: MODEL } });
    k.remember(turn('a', 'user', 'My cat Miso hates the vet.', 'old'));
    k.remember(turn('b', 'user', 'Work was long today.', 'old'));
    await k.idle();
    const context = await k.recall({ sessionId: 'now', query: 'Miso the cat' });
    expect(context.vectorSearch).toBe('used');
    expect(context.episodes[0]?.id).toBe('a');
  });

  it('never returns this session’s own turns — the conversation already holds them', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const { kernel: k } = kernel(store, null);
    k.remember(turn('a', 'user', 'The garden is full of tomatoes.', 'current'));
    await k.idle();
    expect((await k.recall({ sessionId: 'current', query: 'tomatoes garden' })).episodes).toEqual([]);
  });
});

describe('MemoryKernel — namespaces and consolidation', () => {
  it('keeps two characters on one store apart', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const alice = kernel(store, new RepliesLLM([fact({ subject: 'user', predicate: 'lives_in', object: 'Halifax' })])).kernel;
    const bob = new MemoryKernel({ store, characterId: 'bob', extractor: null, now: () => NOW });
    alice.remember(turn('a1', 'user', 'I live in Halifax, near the harbour.', 'sa'));
    alice.remember(turn('a2', 'assistant', 'Lovely.', 'sa'));
    await alice.idle();
    const seen = await bob.recall({ sessionId: 'sb', query: 'Halifax harbour' });
    expect(seen.episodes).toEqual([]);
    expect(seen.facts).toEqual([]);
    expect(await bob.knownFacts()).toEqual([]);
    expect((await alice.recall({ sessionId: 'sa2', query: 'Halifax harbour' })).episodes.map((e) => e.id)).toEqual(['a1']);
  });

  it('consolidates what is in the store, and its own view follows', async () => {
    const store = new FakeMemoryStore({ now: () => NOW });
    const base: SemanticFact = { id: 'x', characterId: 'alice', subject: 'user', predicate: 'likes', object: 'jazz', confidence: 0.6, validFrom: '2026-09-01T00:00:00.000Z', validTo: null, recordedAt: '2026-09-01T00:00:00.000Z', sourceEpisodeId: null, embedding: null };
    await store.upsertFact(base);
    await store.upsertFact({ ...base, id: 'y', recordedAt: '2026-09-02T00:00:00.000Z' });
    const { kernel: k } = kernel(store, null);
    const plan = await k.consolidate();
    expect(plan.expire.map((e) => e.id)).toEqual(['y']);
    expect((await store.currentFacts('alice')).map((f) => [f.id, f.confidence])).toEqual([['x', expect.closeTo(0.84, 5)]]);
    expect((await k.knownFacts()).map((f) => f.id)).toEqual(['x']);
  });
});
