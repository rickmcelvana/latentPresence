import type { DocumentHit, DocumentSearchResponse } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { citationRef, documentSearchTool } from './tool';

const AT = '2026-10-09T12:00:00.000Z';
const CTX = { call: { id: 'c', name: 'documents_search', arguments: {}, source: 'llm' as const, requestedAt: AT } };

const HIT: DocumentHit = { chunkId: '6612', documentId: '24', collection: 'C:/manuals', title: 'Boiler manual', text: 'Hold reset for five seconds.', score: 0.9, source: 'C:/manuals/boiler.pdf', locator: 'p. 12' };

describe('documents_search (P5-T04, ADR-45)', () => {
  it('gives each passage a ref to cite it by, where it is, and hands the hits to the page', async () => {
    const asked: [string, number][] = [];
    const seen: DocumentHit[] = [];
    const tool = documentSearchTool(
      async (query, limit): Promise<DocumentSearchResponse> => {
        asked.push([query, limit]);
        return { hits: [HIT], vectorSearch: 'used' };
      },
      { onFound: (hits) => seen.push(...hits) },
    );
    expect(tool.definition.name).toBe('documents_search');
    expect(await tool.run({ query: ' boiler reset ', limit: 40 }, CTX)).toEqual({
      cite: expect.stringContaining('[cite:c123]'),
      found: [{ ref: 'c6612', document: 'Boiler manual', where: 'p. 12', text: 'Hold reset for five seconds.' }],
    });
    expect(asked).toEqual([['boiler reset', 10]]);
    expect(seen).toEqual([HIT]);
    expect(citationRef(HIT)).toBe('c6612');
  });

  it('says plainly when nothing matches, when there is nothing to look for, and when the search fails', async () => {
    const none = documentSearchTool(async () => ({ hits: [], vectorSearch: 'no-model' }));
    expect(await none.run({ query: 'yacht' }, CTX)).toEqual({ found: [], note: expect.stringContaining('do not make up') });
    expect(await none.run({}, CTX)).toEqual({ error: 'Say what to look for.' });
    const down = documentSearchTool(async () => {
      throw new Error('the companion is not answering (Failed to fetch)');
    });
    expect(await down.run({ query: 'boiler' }, CTX)).toEqual({ error: expect.stringContaining('could not be searched: the companion is not answering') });
  });
});
