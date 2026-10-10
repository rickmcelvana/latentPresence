import { z } from 'zod';
import { IdSchema, JsonObjectSchema, TimestampSchema } from './common';
import {
  DocumentHitSchema,
  EmbeddingModelRefSchema,
  MemoryEpisodeSchema,
  PlanDocumentSchema,
  RetrievalBundleSchema,
  RetrievalRequestSchema,
  SelfModelBlockSchema,
  SemanticFactSchema,
} from './memory';
import { McpCallResultSchema, McpToolAnnotationsSchema } from './providers/mcp';
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
    /**
     * `conflict`: a plan saved over a newer version (ADR-36). `unavailable`: no database, or an
     * MCP server still starting or failed. `upstream`: an MCP server broke during a call (ADR-43).
     */
    code: z.enum(['bad_request', 'not_found', 'conflict', 'unavailable', 'database', 'upstream', 'internal']),
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

/**
 * The embedding model the kernel writes with (ADR-35, ADR-36). Registering creates each
 * collection's vector table for it; a collection with no active model makes this one active,
 * and one that has another stays on it until `dbActivateCollection` — a re-index fills the new
 * table first.
 */
export const VectorCollectionStatusSchema = z.object({
  collection: z.enum(['turns', 'facts', 'chunks']),
  status: z.enum(['building', 'active', 'retired']),
});
export const RegisterEmbeddingModelResponseSchema = z.object({
  modelId: IdSchema,
  collections: z.array(VectorCollectionStatusSchema),
});
export const ActivateCollectionRequestSchema = z.object({
  collection: z.enum(['turns', 'facts', 'chunks']),
  model: EmbeddingModelRefSchema,
});

export const BlocksQuerySchema = z.object({ characterId: IdSchema });
export const ExpireFactRequestSchema = z.object({ id: IdSchema, at: TimestampSchema });
export const FactsQuerySchema = z.object({ characterId: IdSchema });
/** P4-T05: one page of a character's turns, newest first, older than `before` when given. */
export const EpisodesQuerySchema = z.object({ characterId: IdSchema, before: TimestampSchema.optional() });
export const EpisodesResponseSchema = z.object({ episodes: z.array(MemoryEpisodeSchema) });
export const ItemParamsSchema = z.object({ id: IdSchema });
export const FactsResponseSchema = z.object({ facts: z.array(SemanticFactSchema) });
export const BlocksResponseSchema = z.object({ blocks: z.array(SelfModelBlockSchema) });
export const PlansResponseSchema = z.object({ plans: z.array(PlanDocumentSchema) });

/**
 * Document ingestion (P5-T03, ADR-44). **The page never names a path**: the companion indexes
 * the folders its own `documents.json` lists — on disk, edited by the person, like `mcp.json`
 * (ADR-43) — at start, when a file in them changes, and when the page asks for a scan. A page
 * that could point the companion at any path could read any file through retrieval.
 */
export const IngestFailureSchema = z.object({
  /** The file, as the companion found it. */
  source: z.string().min(1),
  error: z.string().min(1),
});
export type IngestFailure = z.infer<typeof IngestFailureSchema>;

export const IngestJobSchema = z.object({
  id: IdSchema,
  status: z.enum(['queued', 'running', 'done', 'failed']),
  /** What started it: the companion starting, a change in a watched folder, or the page. */
  trigger: z.enum(['start', 'watch', 'request']),
  /** Every supported file it looked at. */
  documentsSeen: z.number().int().min(0),
  /** New or changed, and written again. A re-run over unchanged files indexes none. */
  documentsIndexed: z.number().int().min(0),
  /** Gone from disk, so gone from the index. */
  documentsRemoved: z.number().int().min(0),
  chunksWritten: z.number().int().min(0),
  /** Files it could not read; the rest of the job goes on. The first 100. */
  failures: z.array(IngestFailureSchema).max(100),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  /** Why the whole job failed (no database, an embedding endpoint that refused), if it did. */
  error: z.string().nullable(),
});
export type IngestJob = z.infer<typeof IngestJobSchema>;

export const IngestFolderSchema = z.object({
  path: z.string().min(1),
  exists: z.boolean(),
  documents: z.number().int().min(0),
  chunks: z.number().int().min(0),
});

export const IngestStatusSchema = z.object({
  /** `documents.json` as the companion read it at start. */
  folders: z.array(IngestFolderSchema),
  /** The model chunks are embedded with, or null: keyword search only. */
  embedding: z.object({ provider: z.string().min(1), model: z.string().min(1), dimensions: z.number().int().positive() }).nullable(),
  watching: z.boolean(),
  /** The job running now, or the last one. */
  job: IngestJobSchema.nullable(),
  /** Why `documents.json` was not used, when it could not be read. */
  configError: z.string().nullable(),
});
export type IngestStatus = z.infer<typeof IngestStatusSchema>;

/**
 * Her search of the documents (P5-T04, ADR-45). The companion embeds the query itself, with the
 * model and `queryPrefix` from its `documents.json`, and fuses the nearest chunks with the best
 * keyword matches. `vectorSearch` says whether vectors took part: `no-model` (none configured, or
 * not the active one yet), `unavailable` (the endpoint did not answer).
 */
export const DocumentSearchRequestSchema = z.object({
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(10),
});
export type DocumentSearchRequest = z.infer<typeof DocumentSearchRequestSchema>;

export const DocumentSearchResponseSchema = z.object({
  hits: z.array(DocumentHitSchema),
  vectorSearch: z.enum(['used', 'no-model', 'unavailable']),
});
export type DocumentSearchResponse = z.infer<typeof DocumentSearchResponseSchema>;

export const IngestJobParamsSchema = z.object({ id: IdSchema });

/**
 * A server the companion runs or reaches for the page (P5-T02, ADR-43): one from its own
 * `mcp.json` (`stdio`, `http`), its own read-only `files`, or one of the person's databases
 * (`sql`, P5-T05, ADR-46: id `sql:<name>`, label the name). `detail` says why one failed.
 */
export const McpHostServerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['stdio', 'http', 'files', 'sql']),
  state: z.enum(['starting', 'ready', 'failed']),
  detail: z.string().nullable(),
  instructions: z.string().nullable(),
});
export type McpHostServer = z.infer<typeof McpHostServerSchema>;

/** A tool as an MCP server described it. `inputSchema` is JSON Schema, unchanged. */
export const McpToolSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: JsonObjectSchema,
  annotations: McpToolAnnotationsSchema.nullable(),
});
export type McpTool = z.infer<typeof McpToolSchema>;

/** Every server, ready or not, and the tools of the ready ones. */
export const McpToolsResponseSchema = z.object({ servers: z.array(McpHostServerSchema), tools: z.array(McpToolSchema) });
export type McpToolsResponse = z.infer<typeof McpToolsResponseSchema>;

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
  dbRegisterEmbeddingModel: {
    method: 'PUT',
    path: '/db/embedding-models',
    params: null,
    query: null,
    request: EmbeddingModelRefSchema,
    response: RegisterEmbeddingModelResponseSchema,
  },
  dbActivateCollection: {
    method: 'POST',
    path: '/db/collections/activate',
    params: null,
    query: null,
    request: ActivateCollectionRequestSchema,
    response: okSchema,
  },
  dbExpireFact: {
    method: 'POST',
    path: '/db/facts/expire',
    params: null,
    query: null,
    request: ExpireFactRequestSchema,
    response: okSchema,
  },
  dbCurrentFacts: {
    method: 'GET',
    path: '/db/facts',
    params: null,
    query: FactsQuerySchema,
    request: null,
    response: FactsResponseSchema,
  },
  dbDeleteFact: {
    method: 'DELETE',
    path: '/db/facts/:id',
    params: ItemParamsSchema,
    query: null,
    request: null,
    response: okSchema,
  },
  dbListEpisodes: {
    method: 'GET',
    path: '/db/episodes',
    params: null,
    query: EpisodesQuerySchema,
    request: null,
    response: EpisodesResponseSchema,
  },
  dbDeleteEpisode: {
    method: 'DELETE',
    path: '/db/episodes/:id',
    params: ItemParamsSchema,
    query: null,
    request: null,
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

  ingestStatus: {
    method: 'GET',
    path: '/ingest/status',
    params: null,
    query: null,
    request: null,
    response: IngestStatusSchema,
  },
  /** Scan every folder now: the running job if one is running, else a new one (ADR-44). */
  ingestScan: {
    method: 'POST',
    path: '/ingest/scan',
    params: null,
    query: null,
    request: null,
    response: IngestJobSchema,
  },
  documentsSearch: {
    method: 'POST',
    path: '/documents/search',
    params: null,
    query: null,
    request: DocumentSearchRequestSchema,
    response: DocumentSearchResponseSchema,
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
    /** The server's answer flattened, as the page's own adapter makes it; its failure is `isError`. */
    response: McpCallResultSchema,
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
