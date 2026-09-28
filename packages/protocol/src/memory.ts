import { z } from 'zod';
import { UserAffectSchema } from './affect';
import type { MemoryCapabilities } from './capabilities';
import { DurationMsSchema, IdSchema, TimestampSchema, UnitIntervalSchema } from './common';
import type { Schedule } from './schedule';

/**
 * An embedding model as the store knows it (ADR-35): where it runs, its name, its width. The
 * same name from two providers is two models — they may quantise differently. 16383 is
 * MariaDB's `VECTOR` limit.
 */
export const EmbeddingModelRefSchema = z.object({
  /** An endpoint preset (`ollama`, `openai`, …) or `browser`. */
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(255),
  dimensions: z.number().int().min(1).max(16_383),
});
export type EmbeddingModelRef = z.infer<typeof EmbeddingModelRefSchema>;

/**
 * A vector and the model that made it (ADR-36). A bare array cannot say which space it lives
 * in, and a store keeps one vector table per model (ADR-35), so every vector travels with its
 * model.
 */
export const EmbeddingSchema = z
  .object({
    model: EmbeddingModelRefSchema,
    vector: z.array(z.number()),
  })
  .refine((embedding) => embedding.vector.length === embedding.model.dimensions, {
    message: 'the vector must have exactly the model’s dimensions',
    path: ['vector'],
  });
export type Embedding = z.infer<typeof EmbeddingSchema>;

/**
 * One turn of one conversation, the raw material everything else is distilled from. Ids are
 * made by the caller (ADR-36), so a write never has to be awaited to be referred to.
 */
export const MemoryEpisodeSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  characterId: IdSchema,
  role: z.enum(['user', 'assistant']),
  /** For the assistant, what the user **heard** (P1-T12b): an interrupted answer's spoken prefix. */
  text: z.string(),
  /** The answer was cut off by the user; `text` is what reached them. */
  interrupted: z.boolean(),
  at: TimestampSchema,
  /** Omitted on the way out: vectors are large and nothing in the UI reads them. */
  embedding: EmbeddingSchema.nullable(),
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
  /** As on an episode: in on the way in, null on the way out. */
  embedding: EmbeddingSchema.nullable(),
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
  /** Searched only if its model is the active one for the collection (ADR-35). */
  queryEmbedding: EmbeddingSchema.nullable(),
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
  /**
   * Whether the vectors took part, and if not why: the keyword half always does. `other-model`
   * means the query was embedded with a model that is not the active one — re-embed it, or
   * finish the re-index (ADR-35).
   */
  vectorSearch: z.enum(['used', 'no-query-embedding', 'no-active-model', 'other-model']),
  /** Measured at the store, so the round trip can be told apart from the query. */
  elapsedMs: DurationMsSchema,
});
export type RetrievalBundle = z.infer<typeof RetrievalBundleSchema>;

/** How many turns `listEpisodes` returns at a time. */
export const EPISODE_PAGE_SIZE = 50;

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
  /**
   * The store stops believing a fact — a duplicate, or one forgotten (ADR-37) — which is
   * the other time axis from `supersedeFact`: the world did not change, the record did.
   * Nothing is deleted; retrieval no longer returns it.
   */
  expireFact(id: string, at: string): Promise<void>;
  /**
   * A character's facts the store still believes and that still hold (`expired` unset,
   * `validTo` unset or in the future). The memory kernel caches these to reinforce rather
   * than duplicate what it hears again, and consolidation reads them (ADR-37).
   */
  currentFacts(characterId: string): Promise<SemanticFact[]>;
  /**
   * The person removes a fact (P4-T05, ADR-39): **gone**, row and vector — not closed, not
   * expired. What someone asks to be forgotten is not kept. `not_found` if unknown.
   */
  deleteFact(id: string): Promise<void>;

  /**
   * A character's turns, newest first, `EPISODE_PAGE_SIZE` at a time, strictly older than
   * `before` when given — the memory browser's list (P4-T05). Without their vectors.
   */
  listEpisodes(characterId: string, before: string | null): Promise<MemoryEpisode[]>;
  /** The person removes a turn (ADR-39): gone, with its vector. Facts read from it stay, unlinked. */
  deleteEpisode(id: string): Promise<void>;

  readBlocks(characterId: string): Promise<SelfModelBlock[]>;
  writeBlock(block: SelfModelBlock): Promise<void>;

  savePlan(plan: PlanDocument): Promise<void>;
  listPlans(characterId: string): Promise<PlanDocument[]>;

  listSchedules(characterId: string): Promise<Schedule[]>;
  saveSchedule(schedule: Schedule): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
}
