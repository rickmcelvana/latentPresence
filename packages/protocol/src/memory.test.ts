import { describe, expect, it } from 'vitest';
import {
  MemoryEpisodeSchema,
  PlanDocumentSchema,
  RetrievalBundleSchema,
  RetrievalRequestSchema,
  SelfModelBlockSchema,
  SemanticFactSchema,
} from './memory';

describe('MemoryEpisodeSchema', () => {
  it('round-trips a turn with no affect measured', () => {
    const episode = {
      id: 'ep-1',
      sessionId: 'session-1',
      characterId: 'alice',
      role: 'user',
      text: 'I moved to Halifax last month.',
      at: '2026-09-08T10:00:00Z',
      embedding: null,
      affect: null,
    };
    expect(MemoryEpisodeSchema.parse(episode)).toEqual(episode);
  });

  it('will not let a store drop the embedding field silently', () => {
    // null means "not embedded yet", which the consolidation job looks for. A missing
    // field would make an un-embedded episode indistinguishable from a parse bug.
    const { embedding: _dropped, ...withoutEmbedding } = {
      id: 'ep-1',
      sessionId: 'session-1',
      characterId: 'alice',
      role: 'user',
      text: 'x',
      at: '2026-09-08T10:00:00Z',
      embedding: null,
      affect: null,
    };
    expect(MemoryEpisodeSchema.safeParse(withoutEmbedding).success).toBe(false);
  });
});

describe('SemanticFactSchema', () => {
  const fact = {
    id: 'fact-1',
    characterId: 'alice',
    subject: 'user',
    predicate: 'lives_in',
    object: 'Toronto',
    confidence: 0.9,
    validFrom: '2024-01-01T00:00:00Z',
    validTo: null,
    recordedAt: '2026-09-08T10:00:00Z',
    sourceEpisodeId: 'ep-1',
  };

  it('keeps both time axes apart', () => {
    // Superseding sets validTo; it does not touch recordedAt. Collapsing the two would
    // lose the ability to say when we learned something as against when it was true.
    expect(SemanticFactSchema.parse(fact)).toEqual(fact);

    const superseded = SemanticFactSchema.parse({ ...fact, validTo: '2026-08-01T00:00:00Z' });
    expect(superseded.validTo).toBe('2026-08-01T00:00:00Z');
    expect(superseded.recordedAt).toBe(fact.recordedAt);
  });

  it('requires validFrom, so a fact cannot be true since forever by accident', () => {
    const { validFrom: _dropped, ...withoutValidFrom } = fact;
    expect(SemanticFactSchema.safeParse(withoutValidFrom).success).toBe(false);
  });
});

describe('SelfModelBlockSchema', () => {
  it('marks blocks the character may not rewrite', () => {
    // Boundaries are a block the user owns. If editableByCharacter could be absent, a
    // tool call that edits blocks would have to guess.
    const block = {
      characterId: 'alice',
      name: 'boundaries',
      content: 'Never claim to be human when sincerely asked.',
      updatedAt: '2026-09-08T10:00:00Z',
      editableByCharacter: false,
    };
    expect(SelfModelBlockSchema.parse(block)).toEqual(block);
    const { editableByCharacter: _dropped, ...withoutFlag } = block;
    expect(SelfModelBlockSchema.safeParse(withoutFlag).success).toBe(false);
  });
});

describe('PlanDocumentSchema', () => {
  it('versions every save', () => {
    const plan = {
      id: 'plan-1',
      characterId: 'alice',
      title: 'Move house',
      goal: 'Be out by the end of October.',
      phases: [
        {
          id: 'phase-1',
          title: 'Sort',
          tasks: [{ id: 'task-1', title: 'Book movers', status: 'todo', notes: '' }],
        },
      ],
      status: 'active',
      version: 1,
      updatedAt: '2026-09-08T10:00:00Z',
    };
    expect(PlanDocumentSchema.parse(plan)).toEqual(plan);
    // Version 0 would let two concurrent edits of a fresh plan look identical.
    expect(PlanDocumentSchema.safeParse({ ...plan, version: 0 }).success).toBe(false);
  });
});

describe('retrieval', () => {
  it('bounds what one turn can ask for', () => {
    // The budget is one round trip and 100 ms across a WAN (ADR-17). An unbounded
    // limit would turn a single bad prompt into a multi-second stall mid-conversation.
    const request = {
      characterId: 'alice',
      sessionId: 'session-1',
      query: 'where do I live now',
      queryEmbedding: null,
      limits: { episodes: 8, facts: 12, documents: 4 },
      since: null,
    };
    expect(RetrievalRequestSchema.parse(request)).toEqual(request);
    expect(
      RetrievalRequestSchema.safeParse({
        ...request,
        limits: { episodes: 5000, facts: 1, documents: 1 },
      }).success,
    ).toBe(false);
  });

  it('reports the store-side time separately from the round trip', () => {
    // Spike C has to tell tunnel latency apart from query cost; that is only possible
    // if the store says how long it spent.
    const bundle = {
      episodes: [],
      facts: [],
      blocks: [],
      documents: [
        {
          chunkId: 'chunk-1',
          documentId: 'doc-1',
          collection: 'notes',
          title: 'Lease',
          text: 'The lease ends in October.',
          score: 0.82,
          source: '/home/rick/notes/lease.md',
        },
      ],
      elapsedMs: 42,
    };
    expect(RetrievalBundleSchema.parse(bundle)).toEqual(bundle);
    const { elapsedMs: _dropped, ...withoutElapsed } = bundle;
    expect(RetrievalBundleSchema.safeParse(withoutElapsed).success).toBe(false);
  });
});
