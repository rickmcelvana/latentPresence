import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  COMPANION_WS_PATH,
  CompanionErrorSchema,
  CompanionEventSchema,
  HealthResponseSchema,
  IngestRequestSchema,
  McpCallRequestSchema,
  companionRoutes,
} from './companion';

describe('companionRoutes', () => {
  const entries = Object.entries(companionRoutes);

  it('has no two routes on the same method and path', () => {
    // The Rust router and the TS client both build from this table. A duplicate would
    // give one of them a route that quietly never runs.
    const keys = entries.map(([, route]) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every route a response schema and a parseable shape', () => {
    for (const [name, route] of entries) {
      expect(route.response, name).toBeInstanceOf(z.ZodType);
      expect(route.path.startsWith('/'), name).toBe(true);
      if (route.request !== null) {
        expect(route.request, name).toBeInstanceOf(z.ZodType);
      }
    }
  });

  it('declares params for exactly the routes with a path placeholder', () => {
    // A `:id` with no params schema is a route whose id is never validated; a params
    // schema with no placeholder is a schema nothing fills.
    for (const [name, route] of entries) {
      expect(route.path.includes(':'), name).toBe(route.params !== null);
    }
  });

  it('sends nothing in the body of a GET', () => {
    for (const [name, route] of entries) {
      if (route.method === 'GET') {
        expect(route.request, name).toBeNull();
      }
    }
  });

  it('covers the four route groups the companion owns', () => {
    const paths = entries.map(([, route]) => route.path);
    expect(paths).toContain('/health');
    expect(paths.some((path) => path.startsWith('/db/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('/ingest/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('/mcp/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('/schedules'))).toBe(true);
  });
});

describe('HealthResponseSchema', () => {
  it('accepts what the companion actually returns', () => {
    // Kept in step with `health()` in companion/crates/server/src/main.rs, whose own
    // test asserts these same fields from the other side.
    const health = {
      status: 'ok',
      service: 'latentpresence-companion',
      version: '0.0.0',
      database: { kind: 'none', connected: false },
    };
    expect(HealthResponseSchema.parse(health)).toEqual(health);
  });

  it('refuses a health answer from something that is not the companion', () => {
    // The app probes 127.0.0.1; whatever answers there is not necessarily ours.
    const out = HealthResponseSchema.safeParse({
      status: 'ok',
      service: 'some-other-daemon',
      version: '1.0.0',
      database: { kind: 'none', connected: false },
    });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['service']);
  });

  it('requires the database block, so absence is never read as connected', () => {
    const { database: _dropped, ...withoutDatabase } = {
      status: 'ok',
      service: 'latentpresence-companion',
      version: '0.0.0',
      database: { kind: 'none', connected: false },
    };
    expect(HealthResponseSchema.safeParse(withoutDatabase).success).toBe(false);
  });
});

describe('IngestRequestSchema', () => {
  it('fixes the embedding dimension per collection', () => {
    // Mixing dimensions in one collection makes vector search silently wrong rather
    // than failing, so the dimension is part of the request, not a server default.
    const request = {
      collection: 'notes',
      path: '/home/rick/notes',
      recursive: true,
      embeddingModelId: 'nomic-embed-text',
      dimensions: 768,
    };
    expect(IngestRequestSchema.parse(request)).toEqual(request);
    expect(IngestRequestSchema.safeParse({ ...request, dimensions: 0 }).success).toBe(false);
    const { dimensions: _dropped, ...withoutDimensions } = request;
    expect(IngestRequestSchema.safeParse(withoutDimensions).success).toBe(false);
  });
});

describe('McpCallRequestSchema', () => {
  it('names the server as well as the tool', () => {
    // Two MCP servers can both expose `search`. Without serverId the call is ambiguous.
    const call = {
      callId: 'call-1',
      serverId: 'home-assistant',
      name: 'turn_on',
      arguments: { entity_id: 'light.kitchen' },
    };
    expect(McpCallRequestSchema.parse(call)).toEqual(call);
    const { serverId: _dropped, ...withoutServer } = call;
    expect(McpCallRequestSchema.safeParse(withoutServer).success).toBe(false);
  });
});

describe('CompanionErrorSchema', () => {
  it('carries a code the client can branch on and a message it can show', () => {
    const error = {
      error: { code: 'database', message: 'connection refused', details: null },
    };
    expect(CompanionErrorSchema.parse(error)).toEqual(error);
    expect(
      CompanionErrorSchema.safeParse({ error: { code: 'teapot', message: 'x', details: null } })
        .success,
    ).toBe(false);
    // An error with no message gives the UI nothing to say.
    expect(
      CompanionErrorSchema.safeParse({ error: { code: 'internal', message: '', details: null } })
        .success,
    ).toBe(false);
  });
});

describe('CompanionEventSchema', () => {
  it('routes pushed events by type', () => {
    const event = {
      type: 'schedule.due',
      schedule: {
        id: 'sched-1',
        characterId: 'alice',
        description: 'Nightly re-index',
        trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'America/Toronto' },
        taskPrompt: '',
        allowedTools: ['ingest_documents'],
        delivery: 'silent_log',
        catchUp: 'run_once',
        runOn: 'companion',
        status: 'active',
        lastRunAt: null,
        nextRunAt: '2026-09-09T07:00:00Z',
        createdAt: '2026-09-08T10:00:00Z',
      },
    };
    expect(CompanionEventSchema.parse(event)).toEqual(event);
    expect(CompanionEventSchema.safeParse({ type: 'gossip', payload: 1 }).success).toBe(false);
  });

  it('pushes on a path that is not one of the request routes', () => {
    const paths = Object.values(companionRoutes).map((route) => route.path);
    expect(paths).not.toContain(COMPANION_WS_PATH);
  });
});
