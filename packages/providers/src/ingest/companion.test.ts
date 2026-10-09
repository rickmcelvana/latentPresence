import type { IngestJob, IngestStatus } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { companionIngest } from './companion';

const JOB: IngestJob = {
  id: 'job-1',
  status: 'done',
  trigger: 'request',
  documentsSeen: 3,
  documentsIndexed: 2,
  documentsRemoved: 0,
  chunksWritten: 41,
  failures: [{ source: 'C:/docs/broken.pdf', error: 'not a PDF' }],
  startedAt: '2026-10-09T10:00:00.000Z',
  finishedAt: '2026-10-09T10:00:05.000Z',
  error: null,
};

const STATUS: IngestStatus = {
  folders: [{ path: 'C:/docs', exists: true, documents: 3, chunks: 41 }],
  embedding: { provider: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-text', dimensions: 768 },
  watching: true,
  job: JOB,
  configError: null,
};

/** A companion in a `fetch`: each ingest route answers what it is given. */
function companion(answers: { status?: unknown; scan?: unknown; job?: unknown } = {}) {
  const seen: { url: string; method: string; body: unknown }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url.endsWith('/ingest/status')) return Response.json(answers.status ?? STATUS);
    if (url.endsWith('/ingest/scan')) return Response.json(answers.scan ?? JOB);
    if (url.endsWith('/documents/search')) return Response.json(FOUND);
    return Response.json(answers.job ?? JOB);
  };
  return { fetch, seen };
}

const FOUND = {
  hits: [{ chunkId: '12', documentId: '3', collection: 'C:/notes', title: 'Herb notes', text: 'Thyme likes to dry out.', score: 1, source: 'C:/notes/herb-notes.pdf', locator: 'p. 2' }],
  vectorSearch: 'used',
};

async function refusing(): Promise<Response> {
  return Response.json({ error: { code: 'unavailable', message: 'there is no database', details: null } }, { status: 503 });
}

async function down(): Promise<Response> {
  throw new TypeError('Failed to fetch');
}

describe('companionIngest (P5-T03, ADR-44)', () => {
  it('reads the status from GET /ingest/status', async () => {
    const { fetch, seen } = companion();
    expect(await companionIngest({ baseUrl: 'http://127.0.0.1:8787/', fetch }).status()).toEqual(STATUS);
    expect(seen).toEqual([{ url: 'http://127.0.0.1:8787/ingest/status', method: 'GET', body: undefined }]);
  });

  it('asks for a scan with POST /ingest/scan and no body', async () => {
    const { fetch, seen } = companion();
    expect(await companionIngest({ baseUrl: 'http://127.0.0.1:8787', fetch }).scan()).toEqual(JOB);
    expect(seen).toEqual([{ url: 'http://127.0.0.1:8787/ingest/scan', method: 'POST', body: undefined }]);
  });

  it('searches with POST /documents/search, the query and limit as JSON (P5-T04)', async () => {
    const { fetch, seen } = companion();
    expect(await companionIngest({ baseUrl: 'http://127.0.0.1:8787', fetch }).search('thyme', 5)).toEqual(FOUND);
    expect(seen).toEqual([{ url: 'http://127.0.0.1:8787/documents/search', method: 'POST', body: JSON.stringify({ query: 'thyme', limit: 5 }) }]);
  });

  it('reads one job by id, escaped into the path', async () => {
    const { fetch, seen } = companion();
    expect(await companionIngest({ baseUrl: 'http://127.0.0.1:8787', fetch }).job('a b/c')).toEqual(JOB);
    expect(seen[0]).toEqual({ url: 'http://127.0.0.1:8787/ingest/jobs/a%20b%2Fc', method: 'GET', body: undefined });
  });

  it('accepts a status with no job, no embedding and a config error', async () => {
    const bare: IngestStatus = { folders: [], embedding: null, watching: false, job: null, configError: 'documents.json: unknown field "foo"' };
    const { fetch } = companion({ status: bare });
    expect(await companionIngest({ baseUrl: 'http://127.0.0.1:8787', fetch }).status()).toEqual(bare);
  });

  it('throws the companion own words when it answers an error, and when it is not answering', async () => {
    await expect(companionIngest({ baseUrl: 'http://127.0.0.1:8787', fetch: refusing }).scan()).rejects.toThrow('there is no database');
    await expect(companionIngest({ baseUrl: 'http://127.0.0.1:8787', fetch: down }).status()).rejects.toThrow('the companion is not answering (Failed to fetch)');
  });

  it('refuses an answer in another shape — an older companion, say', async () => {
    const { fetch } = companion({ status: { folders: 'none' }, scan: { id: 'x' }, job: [] });
    const ingest = companionIngest({ baseUrl: 'http://127.0.0.1:8787', fetch });
    await expect(ingest.status()).rejects.toThrow(/different version/u);
    await expect(ingest.scan()).rejects.toThrow(/different version/u);
    await expect(ingest.job('x')).rejects.toThrow(/different version/u);
  });
});
