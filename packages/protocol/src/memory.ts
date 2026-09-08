import { z } from 'zod';
import { UserAffectSchema } from './affect';
import type { MemoryCapabilities } from './capabilities';
import { DurationMsSchema, IdSchema, TimestampSchema, UnitIntervalSchema } from './common';
import type { Schedule } from './schedule';

/** One turn of one conversation, the raw material everything else is distilled from. */
export const MemoryEpisodeSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  characterId: IdSchema,
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  at: TimestampSchema,
  /** Omitted on the way out: vectors are large and nothing in the UI reads them. */
  embedding: z.array(z.number()).nullable(),
  /** How the user seemed when they said it, for the episodes where we measured. */
  affect: UserAffectSchema.nullable(),
});
export type MemoryEpisode = z.infer<typeof MemoryEpisodeSchema>;

/**
 * A fact with two time axes: when it was true, and when we learned it. "I moved" closes
 * the old address rather than contradicting it, so the character can say what it used to
 * believe and when that changed (RESEARCH section 6).
 */
export const SemanticFactSchema = z.object({
  id: IdSchema,
  characterId: IdSchema,
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string(),
  confidence: UnitIntervalSchema,
  /** When the fact started being true in the world. */
  validFrom: TimestampSchema,
  /** null while it still holds. Set, never deleted, when superseded. */
  validTo: TimestampSchema.nullable(),
  /** When we recorded it, which is a different question from when it was true. */
  recordedAt: TimestampSchema,
  sourceEpisodeId: IdSchema.nullable(),
});
export type SemanticFact = z.infer<typeof SemanticFactSchema>;

/**
 * A block of the character's self-model: persona, current preoccupations, how it feels
 * about the user. The character edits these with tools, which is why they are named
 * blocks rather than a blob of prompt.
 */
export const SelfModelBlockSchema = z.object({
  characterId: IdSchema,
  name: z.string().min(1).max(64),
  content: z.string(),
  updatedAt: TimestampSchema,
  /** False for blocks only the user may change, like hard boundaries. */
  editableByCharacter: z.boolean(),
});
export type SelfModelBlock = z.infer<typeof SelfModelBlockSchema>;

export const PlanTaskSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  status: z.enum(['todo', 'doing', 'done', 'dropped']),
  notes: z.string(),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const PlanPhaseSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  tasks: z.array(PlanTaskSchema),
});
export type PlanPhase = z.infer<typeof PlanPhaseSchema>;

/** The output of "let's plan X": structured, versioned, and followed up on later. */
export const PlanDocumentSchema = z.object({
  id: IdSchema,
  characterId: IdSchema,
  title: z.string().min(1),
  goal: z.string(),
  phases: z.array(PlanPhaseSchema),
  status: z.enum(['draft', 'active', 'done', 'archived']),
  /** Increments on every save, so an edit made in the panel cannot silently lose one. */
  version: z.number().int().min(1),
  updatedAt: TimestampSchema,
});
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

/** A retrieved chunk of an ingested document, with enough to render a citation. */
export const DocumentHitSchema = z.object({
  chunkId: IdSchema,
  documentId: IdSchema,
  collection: z.string().min(1),
  title: z.string(),
  text: z.string(),
  score: UnitIntervalSchema,
  /** Where it came from, so a citation can be opened. */
  source: z.string(),
});
export type DocumentHit = z.infer<typeof DocumentHitSchema>;

/**
 * What one turn asks memory for. The caller may supply the query vector when it already
 * embedded the turn, so the store does not embed it a second time.
 */
export const RetrievalRequestSchema = z.object({
  characterId: IdSchema,
  sessionId: IdSchema,
  query: z.string(),
  queryEmbedding: z.array(z.number()).nullable(),
  limits: z.object({
    episodes: z.number().int().min(0).max(100),
    facts: z.number().int().min(0).max(100),
    documents: z.number().int().min(0).max(100),
  }),
  /** Restricts episodes to a window; null means no bound. */
  since: TimestampSchema.nullable(),
});
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;

/**
 * Everything a turn needs, in one answer. This shape exists because the development
 * database is across a WAN: four round trips per turn would blow the latency budget on
 * its own, so the interface only offers one (ADR-17).
 */
export const RetrievalBundleSchema = z.object({
  episodes: z.array(MemoryEpisodeSchema),
  facts: z.array(SemanticFactSchema),
  blocks: z.array(SelfModelBlockSchema),
  documents: z.array(DocumentHitSchema),
  /** Measured at the store, so the round trip can be told apart from the query. */
  elapsedMs: DurationMsSchema,
});
export type RetrievalBundle = z.infer<typeof RetrievalBundleSchema>;

/**
 * The memory store behind the kernel. Adapters: `mariadb` through the companion,
 * `sqlite` with sqlite-vec, and `indexeddb` for the browser on its own (ADR-05).
 *
 * Two rules the shape enforces. Reads for a turn go through `retrieve`, once. Writes
 * never block the speaking path, so callers fire them without awaiting and adapters
 * must not depend on being awaited.
 */
export interface MemoryStore {
  readonly id: string;
  capabilities(): Promise<MemoryCapabilities>;

  retrieve(request: RetrievalRequest): Promise<RetrievalBundle>;

  appendEpisode(episode: MemoryEpisode): Promise<void>;
  upsertFact(fact: SemanticFact): Promise<void>;
  /** Closes a fact at a moment rather than deleting it, keeping the history readable. */
  supersedeFact(id: string, validTo: string): Promise<void>;

  readBlocks(characterId: string): Promise<SelfModelBlock[]>;
  writeBlock(block: SelfModelBlock): Promise<void>;

  savePlan(plan: PlanDocument): Promise<void>;
  listPlans(characterId: string): Promise<PlanDocument[]>;

  listSchedules(characterId: string): Promise<Schedule[]>;
  saveSchedule(schedule: Schedule): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
}
