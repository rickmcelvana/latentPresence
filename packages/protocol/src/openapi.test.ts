import { describe, expect, it } from 'vitest';
import committed from './generated/companion.openapi.json' with { type: 'json' };
import { PROTOCOL_VERSION, companionRoutes } from './index';
import { companionOpenApi } from './openapi';

describe('companionOpenApi (P4-T02)', () => {
  it('is what is committed — run `pnpm openapi` after changing a route or a schema it uses', () => {
    // The companion's tests validate its responses against the committed file, so a stale
    // file would let the Rust side drift from the zod table while both test suites passed.
    expect(companionOpenApi(PROTOCOL_VERSION)).toEqual(committed);
  });

  it('has an operation for every route, named after it', () => {
    const doc = companionOpenApi(PROTOCOL_VERSION) as { paths: Record<string, Record<string, { operationId: string }>> };
    const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((operation) => operation.operationId));
    expect(operations.toSorted()).toEqual(Object.keys(companionRoutes).toSorted());
  });

  it('writes a path parameter the OpenAPI way', () => {
    const doc = companionOpenApi(PROTOCOL_VERSION) as { paths: Record<string, unknown> };
    expect(doc.paths['/ingest/jobs/{id}']).toBeDefined();
    expect(doc.paths['/ingest/jobs/:id']).toBeUndefined();
  });
});
