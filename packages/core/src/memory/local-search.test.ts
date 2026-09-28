import type { Embedding, EmbeddingModelRef } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { cosine, isCurrentFact, overlap, rankHits, sameModel, vectorSearchOutcome, words } from './local-search';

const MODEL_A: EmbeddingModelRef = { provider: 'test', model: 'a', dimensions: 3 };
const MODEL_B: EmbeddingModelRef = { provider: 'test', model: 'b', dimensions: 3 };
const vector = (model: EmbeddingModelRef, values: number[]): Embedding => ({ model, vector: values });

describe('sameModel', () => {
  it('compares provider, model and dimensions', () => {
    expect(sameModel(MODEL_A, { ...MODEL_A })).toBe(true);
    expect(sameModel(MODEL_A, MODEL_B)).toBe(false);
    expect(sameModel(MODEL_A, { ...MODEL_A, dimensions: 4 })).toBe(false);
  });
});

describe('cosine', () => {
  it('is 1 for identical directions and 0 for orthogonal ones', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it('is 0 against a zero vector rather than dividing by zero', () => {
    expect(cosine([0, 0, 0], [1, 0, 0])).toBe(0);
  });
});

describe('words / overlap', () => {
  it('lower-cases, splits on non-letters and drops short tokens', () => {
    expect(words('The Quokkaberry-harvest, at 3am!')).toEqual(new Set(['the', 'quokkaberry', 'harvest', '3am']));
  });

  it('counts how many query words appear in the text', () => {
    const query = words('quokkaberry harvest');
    expect(overlap(query, 'We talked about the quokkaberry harvest')).toBe(2);
    expect(overlap(query, 'Nothing related here')).toBe(0);
  });
});

describe('vectorSearchOutcome', () => {
  it('says why a vector was or was not used', () => {
    expect(vectorSearchOutcome(null, MODEL_A)).toBe('no-query-embedding');
    expect(vectorSearchOutcome(vector(MODEL_A, [1, 0, 0]), undefined)).toBe('no-active-model');
    expect(vectorSearchOutcome(vector(MODEL_A, [1, 0, 0]), MODEL_B)).toBe('other-model');
    expect(vectorSearchOutcome(vector(MODEL_A, [1, 0, 0]), MODEL_A)).toBe('used');
  });
});

describe('isCurrentFact', () => {
  it('is false once expired, true with no end, and depends on the clock otherwise', () => {
    expect(isCurrentFact('2026-01-01T00:00:00.000Z', null, Date.now())).toBe(false);
    expect(isCurrentFact(null, null, Date.now())).toBe(true);
    expect(isCurrentFact(null, '2020-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:00:00.000Z'))).toBe(false);
    expect(isCurrentFact(null, '2030-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('rankHits', () => {
  it('puts vector hits first, nearest first, then keyword hits, deduplicated and limited', () => {
    const near = { id: 'near', text: 'unrelated words' };
    const far = { id: 'far', text: 'unrelated words' };
    const wordy = { id: 'wordy', text: 'the quokkaberry harvest' };
    const rows = [
      { row: far, embedding: vector(MODEL_A, [0, 1, 0]) },
      { row: near, embedding: vector(MODEL_A, [1, 0, 0]) },
      { row: wordy, embedding: null },
    ];
    const hits = rankHits(rows, words('quokkaberry'), (row) => row.text, vector(MODEL_A, [1, 0, 0]), 10);
    expect(hits.map((row) => row.id)).toEqual(['near', 'far', 'wordy']);
  });

  it('ignores embeddings on a different model and respects the limit', () => {
    const onModel = { id: 'on', text: 'x' };
    const offModel = { id: 'off', text: 'x' };
    const rows = [
      { row: onModel, embedding: vector(MODEL_A, [1, 0, 0]) },
      { row: offModel, embedding: vector(MODEL_B, [1, 0, 0]) },
    ];
    const hits = rankHits(rows, words(''), (row) => row.text, vector(MODEL_A, [1, 0, 0]), 1);
    expect(hits.map((row) => row.id)).toEqual(['on']);
  });

  it('falls back to keyword ranking alone when there is no query vector', () => {
    const match = { id: 'match', text: 'quokkaberry harvest' };
    const nomatch = { id: 'nomatch', text: 'something else entirely' };
    const rows = [
      { row: nomatch, embedding: null },
      { row: match, embedding: null },
    ];
    const hits = rankHits(rows, words('quokkaberry'), (row) => row.text, null, 10);
    expect(hits.map((row) => row.id)).toEqual(['match']);
  });
});
