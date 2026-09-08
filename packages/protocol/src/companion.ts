import { z } from 'zod';
import { IdSchema, JsonObjectSchema, TimestampSchema } from './common';
import { ToolResultSchema } from './conversation';
import {
  MemoryEpisodeSchema,
  PlanDocumentSchema,
  RetrievalBundleSchema,
  RetrievalRequestSchema,
  SelfModelBlockSchema,
  SemanticFactSchema,
} from './memory';
import { ScheduleRunSchema, ScheduleSchema } from './schedule';

/**
 * The companion is the optional local Rust service: MariaDB memory, document ingest and
 * MCP tools. This module is the contract between it and the browser. The Rust side
 * implements these shapes; the TS client parses every response against them, because a
 * companion can be an older build than the page talking to it.
 */

/** One error shape for every route, so the client has one thing to handle. */
export const CompanionErrorSchema = z.object({
  error: z.object({
    code: z.enum(['bad_request', 'not_found', 'unavailable', 'database', 'internal']),
    message: z.string().min(1),
    details: JsonObjectSchema.nullable(),
  }),
});
export type CompanionError = z.infer<typeof CompanionErrorSchema>;

const okSchema = z.object({ ok: z.literal(true) });

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('latentpresence-companion'),
  version: z.string().min(1),
  database: z.object({
    kind: z.enum(['mariadb', 'sqlite', 'none']),
    connected: z.boolean(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const SupersedeFactRequestSchema = z.object({
  id: IdSchema,
  validTo: TimestampSchema,
});

export const BlocksQuerySchema = z.object({ characterId: IdSchema });
export const BlocksResponseSchema = z.object({ blocks: z.array(SelfModelBlockSchema) });
export const PlansResponseSchema = z.object({ plans: z.array(PlanDocumentSchema) });

/**
 * Ingest takes a path on the companion's own machine, not file bytes over HTTP. The
 * companion is local by definition, and streaming a folder of PDFs through the browser
 * would be slower and would put the user's documents on the wire for no reason.
 */
export const IngestRequestSchema = z.object({
  collection: z.string().min(1),
  path: z.string().min(1),
  recursive: z.boolean(),
  embeddingModelId: z.string().min(1),
  /** Fixed per collection: a collection with mixed dimensions cannot be searched. */
  dimensions: z.number().int().positive(),
});
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

export const IngestJobSchema = z.object({
  id: IdSchema,
  collection: z.string().min(1),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  documentsSeen: z.number().int().min(0),
  chunksWritten: z.number().int().min(0),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  error: z.string().nullable(),
});
export type IngestJob = z.infer<typeof IngestJobSchema>;

export const IngestJobParamsSchema = z.object({ id: IdSchema });

/** A tool as an MCP server described it. `inputSchema` is JSON Schema, unchanged. */
export const McpToolSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: JsonObjectSchema,
});
export type McpTool = z.infer<typeof McpToolSchema>;

export const McpToolsResponseSchema = z.object({ tools: z.array(McpToolSchema) });

export const McpCallRequestSchema = z.object({
  callId: IdSchema,
  serverId: z.string().min(1),
  name: z.string().min(1),
  arguments: JsonObjectSchema,
});
export type McpCallRequest = z.infer<typeof McpCallRequestSchema>;

export const SchedulesQuerySchema = z.object({ characterId: IdSchema });
export const SchedulesResponseSchema = z.object({ schedules: z.array(ScheduleSchema) });
export const ScheduleParamsSchema = z.object({ id: IdSchema });
export const ScheduleDueRequestSchema = z.object({
  characterId: IdSchema,
  now: TimestampSchema,
});

/** One route: how to call it, what goes up, what comes back. */
export interface CompanionRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** `:name` segments are filled from `params`. */
  readonly path: string;
  readonly params: z.ZodType | null;
  readonly query: z.ZodType | null;
  readonly request: z.ZodType | null;
  readonly response: z.ZodType;
}

/**
 * Every route the companion serves. One table, so the Rust router (P0-T06 onward), the
 * TS client and the tests all read the same list instead of three drifting copies.
 */
export const companionRoutes = {
  health: {
    method: 'GET',
    path: '/health',
    params: null,
    query: null,
    request: null,
    response: HealthResponseSchema,
  },

  dbRetrieve: {
    method: 'POST',
    path: '/db/retrieve',
    params: null,
    query: null,
    request: RetrievalRequestSchema,
    response: RetrievalBundleSchema,
  },
  dbAppendEpisode: {
    method: 'POST',
    path: '/db/episodes',
    params: null,
    query: null,
    request: MemoryEpisodeSchema,
    response: okSchema,
  },
  dbUpsertFact: {
    method: 'POST',
    path: '/db/facts',
    params: null,
    query: null,
    request: SemanticFactSchema,
    response: okSchema,
  },
  dbSupersedeFact: {
    method: 'POST',
    path: '/db/facts/supersede',
    params: null,
    query: null,
    request: SupersedeFactRequestSchema,
    response: okSchema,
  },
  dbReadBlocks: {
    method: 'GET',
    path: '/db/blocks',
    params: null,
    query: BlocksQuerySchema,
    request: null,
    response: BlocksResponseSchema,
  },
  dbWriteBlock: {
    method: 'PUT',
    path: '/db/blocks',
    params: null,
    query: null,
    request: SelfModelBlockSchema,
    response: okSchema,
  },
  dbListPlans: {
    method: 'GET',
    path: '/db/plans',
    params: null,
    query: BlocksQuerySchema,
    request: null,
    response: PlansResponseSchema,
  },
  dbSavePlan: {
    method: 'POST',
    path: '/db/plans',
    params: null,
    query: null,
    request: PlanDocumentSchema,
    response: okSchema,
  },

  ingestStart: {
    method: 'POST',
    path: '/ingest/documents',
    params: null,
    query: null,
    request: IngestRequestSchema,
    response: IngestJobSchema,
  },
  ingestJob: {
    method: 'GET',
    path: '/ingest/jobs/:id',
    params: IngestJobParamsSchema,
    query: null,
    request: null,
    response: IngestJobSchema,
  },

  mcpTools: {
    method: 'GET',
    path: '/mcp/tools',
    params: null,
    query: null,
    request: null,
    response: McpToolsResponseSchema,
  },
  mcpCall: {
    method: 'POST',
    path: '/mcp/call',
    params: null,
    query: null,
    request: McpCallRequestSchema,
    response: ToolResultSchema,
  },

  schedulesList: {
    method: 'GET',
    path: '/schedules',
    params: null,
    query: SchedulesQuerySchema,
    request: null,
    response: SchedulesResponseSchema,
  },
  schedulesSave: {
    method: 'POST',
    path: '/schedules',
    params: null,
    query: null,
    request: ScheduleSchema,
    response: ScheduleSchema,
  },
  schedulesDelete: {
    method: 'DELETE',
    path: '/schedules/:id',
    params: ScheduleParamsSchema,
    query: null,
    request: null,
    response: okSchema,
  },
  schedulesDue: {
    method: 'POST',
    path: '/schedules/due',
    params: null,
    query: null,
    request: ScheduleDueRequestSchema,
    response: SchedulesResponseSchema,
  },
  schedulesRecordRun: {
    method: 'POST',
    path: '/schedules/runs',
    params: null,
    query: null,
    request: ScheduleRunSchema,
    response: okSchema,
  },
} as const satisfies Record<string, CompanionRoute>;

export type CompanionRouteName = keyof typeof companionRoutes;

/** Where the push channel lives. Same origin and port as the routes above. */
export const COMPANION_WS_PATH = '/ws';

/**
 * What the companion pushes without being asked: progress on long work, and schedules
 * coming due while the app is open so the core can run them.
 */
export const CompanionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ingest.progress'), job: IngestJobSchema }),
  z.object({ type: z.literal('schedule.due'), schedule: ScheduleSchema }),
  z.object({ type: z.literal('schedule.finished'), run: ScheduleRunSchema }),
  z.object({ type: z.literal('health'), health: HealthResponseSchema }),
]);
export type CompanionEvent = z.infer<typeof CompanionEventSchema>;
