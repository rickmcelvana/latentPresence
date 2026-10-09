import type { DocumentSearchResponse, IngestStatus } from '@latentpresence/protocol';
import type { CompanionIngest } from '@latentpresence/providers/web';
import { describe, expect, it } from 'vitest';
import { connectDocuments } from './chat-documents';

const AT = '2026-10-09T12:00:00.000Z';
const CTX = { call: { id: 'c', name: 'documents_search', arguments: {}, source: 'llm' as const, requestedAt: AT } };

const STATUS: IngestStatus = {
  folders: [{ path: 'C:/manuals', exists: true, documents: 3, chunks: 40 }],
  embedding: null,
  watching: true,
  job: null,
  configError: null,
};

const FOUND: DocumentSearchResponse = {
  hits: [{ chunkId: '6612', documentId: '24', collection: 'C:/manuals', title: 'Boiler manual', text: 'Hold reset for eleven seconds.', score: 1, source: 'C:/manuals/boiler.pdf', locator: 'p. 7' }],
  vectorSearch: 'no-model',
};

function ingest(status: IngestStatus | Error = STATUS): CompanionIngest {
  return {
    status: async () => {
      if (status instanceof Error) throw status;
      return status;
    },
    scan: async () => {
      throw new Error('not used');
    },
    job: async () => {
      throw new Error('not used');
    },
    search: async () => FOUND,
  };
}

describe('connectDocuments (P5-T04, ADR-45)', () => {
  it('offers her the tool when the companion has documents, and keeps every hit she is given by its ref', async () => {
    const connected = await connectDocuments({ companionUrl: 'http://127.0.0.1:8787', ingest: ingest() });
    expect(connected.notice).toBeNull();
    expect(connected.tool?.definition.name).toBe('documents_search');
    await connected.tool?.run({ query: 'boiler reset' }, CTX);
    expect(connected.sources.get('c6612')).toEqual({ title: 'Boiler manual', locator: 'p. 7', source: 'C:/manuals/boiler.pdf', text: 'Hold reset for eleven seconds.' });
  });

  it('says why there is no tool: nothing indexed, or a companion that is not answering', async () => {
    const empty = await connectDocuments({ companionUrl: 'x', ingest: ingest({ ...STATUS, folders: [] }) });
    expect(empty).toMatchObject({ tool: null, notice: expect.stringContaining('none indexed yet') });
    const down = await connectDocuments({ companionUrl: 'x', ingest: ingest(new Error('the companion is not answering (Failed to fetch)')) });
    expect(down).toMatchObject({ tool: null, notice: expect.stringContaining('the companion is not answering (Failed to fetch); start it with "pnpm companion"') });
  });
});
