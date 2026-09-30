import type { Embedding, EmbeddingModelRef, EmbeddingProvider, LLMProvider, MemoryEpisode, MemoryStore, SemanticFact, UserAffect } from '@latentpresence/protocol';
import { consolidateFacts, DEFAULT_FORGETTING, type ConsolidationPlan, type ForgettingPolicy } from './consolidate';
import { extractionMessages, parseExtraction, type Exchange } from './extract';
import { planFactWrites, type ExtractedFact } from './facts';
import { DEFAULT_RECALL_PARAMS, rankRecall, type MemoryContext, type RecallParams } from './recall';

/**
 * The memory kernel (P4-T03): what one character remembers of the person, written after
 * each exchange and read before each turn, over any `MemoryStore` (ADR-05).
 *
 * **Namespaces.** A kernel belongs to one character (`characterId`) and every read and
 * write carries it; two characters on one store never see each other's memory.
 *
 * **Writing never blocks speaking (ADR-17).** `remember` queues and returns at once. The
 * queue runs one job at a time, in order: store the turn (embedded, if there is an
 * embedder), and after the character's answer, extract facts from the exchange (one model
 * call, `extract.ts`) and apply them against the facts already believed (`facts.ts`). A
 * failure is reported to `onError` and the queue carries on — memory is never a reason for
 * the conversation to stop.
 *
 * **The current facts are held in the kernel**, loaded once from `currentFacts` and kept up
 * to date by its own writes (ADR-17's in-process cache): extraction shows them to the model
 * so it can say what a new fact replaces, and reinforcement needs them to recognise a fact
 * heard again. One kernel per character per store is the assumption; `consolidate` reloads.
 *
 * **Reading is one call.** `recall` embeds the query (if it can) and asks the store once
 * (`retrieve`), then re-ranks by relevance, recency and importance (`recall.ts`).
 */

export interface MemoryTurn {
  readonly id: string;
  readonly sessionId: string;
  readonly role: 'user' | 'assistant';
  /** For the assistant, what the user heard (P1-T12b). */
  readonly text: string;
  readonly interrupted: boolean;
  /** ISO-8601. */
  readonly at: string;
  readonly affect: UserAffect | null;
}

export interface ExtractionRecord {
  readonly exchange: Exchange;
  readonly known: readonly SemanticFact[];
  /** The model's reply, verbatim — what a recording keeps so a replay needs no model. */
  readonly reply: string;
  readonly facts: readonly ExtractedFact[];
  readonly ended: readonly string[];
  readonly dropped: number | null;
}

export type MemoryErrorStage = 'append' | 'embed' | 'extract' | 'apply' | 'consolidate';

export interface MemoryKernelOptions {
  readonly store: MemoryStore;
  readonly characterId: string;
  /** The model that reads facts out of an exchange; null stores turns and nothing more. */
  readonly extractor: { readonly llm: LLMProvider; readonly modelId: string } | null;
  /** Embeds turns, facts and queries; omitted, retrieval is keyword only. */
  readonly embedder?: { readonly provider: EmbeddingProvider; readonly model: EmbeddingModelRef } | null;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly recall?: RecallParams;
  readonly forgetting?: ForgettingPolicy;
  readonly onError?: (error: Error, stage: MemoryErrorStage) => void;
  /** Every extraction, as it happens: for a recorder, a debug panel, or a live check. */
  readonly onExtraction?: (record: ExtractionRecord) => void;
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `mem-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class MemoryKernel {
  readonly characterId: string;
  private readonly options: MemoryKernelOptions;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private tail: Promise<void> = Promise.resolve();
  /** The user's words since the last extraction, with the first one's id for provenance. */
  private pending: { readonly text: string; readonly id: string }[] = [];
  private known: Map<string, SemanticFact> | null = null;

  constructor(options: MemoryKernelOptions) {
    this.options = options;
    this.characterId = options.characterId;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  /** Queue a turn to be stored, and — after an answer — read for facts. Returns at once. */
  remember(turn: MemoryTurn): void {
    this.enqueue(async () => {
      await this.store(turn);
      if (turn.role === 'user') {
        this.pending.push({ text: turn.text, id: turn.id });
        return;
      }
      const user = this.pending;
      this.pending = [];
      if (user.length === 0 || this.options.extractor === null) return;
      await this.extract({ user: user.map((line) => line.text), assistant: turn.text, at: turn.at }, user[0]?.id ?? null);
    });
  }

  /** Resolves once everything queued so far is written. For tests and shutdown. */
  idle(): Promise<void> {
    return this.tail;
  }

  /** What to remember for this turn: one `retrieve`, re-ranked. */
  async recall(request: { readonly sessionId: string; readonly query: string; readonly since?: string | null }): Promise<MemoryContext> {
    const params = this.options.recall ?? DEFAULT_RECALL_PARAMS;
    let queryEmbedding: Embedding | null = null;
    const embedder = this.options.embedder;
    if (embedder !== null && embedder !== undefined && request.query.trim() !== '') {
      try {
        const [vector] = await embedder.provider.embed([request.query]);
        if (vector !== undefined) queryEmbedding = { model: embedder.model, vector };
      } catch (error) {
        this.report(error, 'embed');
      }
    }
    const bundle = await this.options.store.retrieve({
      characterId: this.characterId,
      sessionId: request.sessionId,
      query: request.query,
      queryEmbedding,
      limits: { episodes: params.maxEpisodes * params.fetchFactor, facts: params.maxFacts * params.fetchFactor, documents: 0 },
      since: request.since ?? null,
    });
    return rankRecall(bundle, this.now(), params);
  }

  /** The facts the kernel currently believes, as it holds them. */
  async knownFacts(): Promise<SemanticFact[]> {
    return [...(await this.loadKnown()).values()];
  }

  /**
   * The person removes a fact (P4-T05, ADR-39): deleted from the store, gone from the cache,
   * queued behind any writes so an extraction in flight cannot write it back from a stale view.
   */
  deleteFact(id: string): Promise<void> {
    return this.enqueueResult(async () => {
      await this.options.store.deleteFact(id);
      (await this.loadKnown()).delete(id);
    });
  }

  /**
   * The person corrects a fact (P4-T05): written in place, same id, re-embedded, and taken as
   * certain — they said so. Its record time is now; when it was true is theirs to set.
   */
  correctFact(fact: SemanticFact): Promise<void> {
    return this.enqueueResult(async () => {
      const corrected: SemanticFact = { ...fact, characterId: this.characterId, confidence: 1, recordedAt: this.now().toISOString(), embedding: null };
      const [embedding = null] = await this.embed([`${corrected.subject} ${corrected.predicate} ${corrected.object}`.replaceAll('_', ' ')]);
      await this.options.store.upsertFact({ ...corrected, embedding });
      (await this.loadKnown()).set(corrected.id, corrected);
    });
  }

  /**
   * A fact the page states rather than hears — a plan's follow-up (P4-T07, ADR-41): written
   * as given, embedded, and cached, queued behind any extraction so the two cannot interleave.
   */
  recordFact(fact: SemanticFact): Promise<void> {
    return this.enqueueResult(async () => {
      const recorded: SemanticFact = { ...fact, characterId: this.characterId, embedding: null };
      const [embedding = null] = await this.embed([`${recorded.subject} ${recorded.predicate} ${recorded.object}`.replaceAll('_', ' ')]);
      await this.options.store.upsertFact({ ...recorded, embedding });
      (await this.loadKnown()).set(recorded.id, recorded);
    });
  }

  /** A fact stops holding now (`supersedeFact`), and leaves the cache: the history keeps it. */
  closeFact(id: string): Promise<void> {
    return this.enqueueResult(async () => {
      await this.options.store.supersedeFact(id, this.now().toISOString());
      (await this.loadKnown()).delete(id);
    });
  }

  /** The person removes a turn (ADR-39). A fact read from it stays; delete that separately. */
  deleteEpisode(id: string): Promise<void> {
    return this.enqueueResult(async () => {
      await this.options.store.deleteEpisode(id);
      this.pending = this.pending.filter((line) => line.id !== id);
    });
  }

  /** One page of this character's turns, newest first (the memory browser). */
  listEpisodes(before: string | null): Promise<MemoryEpisode[]> {
    return this.options.store.listEpisodes(this.characterId, before);
  }

  /** Turns found by their words (or meaning, with an embedder), from every session — the browser's search. */
  async searchEpisodes(query: string): Promise<MemoryEpisode[]> {
    let queryEmbedding: Embedding | null = null;
    const embedder = this.options.embedder;
    if (embedder !== null && embedder !== undefined && query.trim() !== '') {
      const [vector] = await this.embed([query]);
      queryEmbedding = vector ?? null;
    }
    const bundle = await this.options.store.retrieve({
      characterId: this.characterId,
      // No real session is called this, so none is left out.
      sessionId: 'memory-browser',
      query,
      queryEmbedding,
      limits: { episodes: 50, facts: 0, documents: 0 },
      since: null,
    });
    return bundle.episodes;
  }

  /** The "sleep" pass (`consolidate.ts`), queued behind any writes; returns what it changed. */
  consolidate(): Promise<ConsolidationPlan> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          this.known = null;
          const facts = await this.knownFacts();
          const plan = consolidateFacts(facts, this.now(), this.options.forgetting ?? DEFAULT_FORGETTING);
          await this.apply(plan.upserts, plan.supersede, plan.expire);
          resolve(plan);
        } catch (error) {
          this.report(error, 'consolidate');
          reject(asError(error));
        }
      });
    });
  }

  /** A queued job whose outcome the caller awaits — the person is waiting on it, so it rejects rather than only reporting. */
  private enqueueResult(job: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          await job();
          resolve();
        } catch (error) {
          reject(asError(error));
        }
      });
    });
  }

  private enqueue(job: () => Promise<void>): void {
    this.tail = this.tail.then(job).catch((error: unknown) => this.report(error, 'apply'));
  }

  private report(error: unknown, stage: MemoryErrorStage): void {
    this.options.onError?.(asError(error), stage);
  }

  private async embed(texts: readonly string[]): Promise<(Embedding | null)[]> {
    const embedder = this.options.embedder;
    if (embedder === null || embedder === undefined || texts.length === 0) return texts.map(() => null);
    try {
      const vectors = await embedder.provider.embed(texts);
      return texts.map((_, i) => {
        const vector = vectors[i];
        return vector === undefined || vector.length !== embedder.model.dimensions ? null : { model: embedder.model, vector };
      });
    } catch (error) {
      this.report(error, 'embed');
      return texts.map(() => null);
    }
  }

  private async store(turn: MemoryTurn): Promise<void> {
    const [embedding = null] = await this.embed([turn.text]);
    const episode: MemoryEpisode = {
      id: turn.id,
      sessionId: turn.sessionId,
      characterId: this.characterId,
      role: turn.role,
      text: turn.text,
      interrupted: turn.interrupted,
      at: turn.at,
      embedding,
      affect: turn.affect,
    };
    try {
      await this.options.store.appendEpisode(episode);
    } catch (error) {
      this.report(error, 'append');
    }
  }

  private async loadKnown(): Promise<Map<string, SemanticFact>> {
    if (this.known === null) {
      const facts = await this.options.store.currentFacts(this.characterId);
      this.known = new Map(facts.map((fact) => [fact.id, fact]));
    }
    return this.known;
  }

  private async extract(exchange: Exchange, sourceEpisodeId: string | null): Promise<void> {
    const extractor = this.options.extractor;
    if (extractor === null) return;
    const known = [...(await this.loadKnown()).values()];
    let reply = '';
    try {
      for await (const chunk of extractor.llm.stream({
        modelId: extractor.modelId,
        messages: extractionMessages(exchange, known),
        tools: [],
        // Never 0: a thinking model can spend its whole budget reasoning at 0 (P1-T02).
        temperature: null,
        maxOutputTokens: null,
        // A plain answer, fast, and whole: glm-5.2:cloud cut the start off its JSON where its
        // reasoning ended, 6 replies in 30, and never with reasoning off (ADR-37).
        reasoning: 'off',
      })) {
        if (chunk.type === 'text-delta') reply += chunk.text;
        if (chunk.type === 'finish' && chunk.reason === 'error') throw new Error('the extraction stream ended in error');
      }
    } catch (error) {
      this.report(error, 'extract');
      return;
    }
    const parsed = parseExtraction(reply);
    this.options.onExtraction?.({ exchange, known, reply, facts: parsed.facts, ended: parsed.ended, dropped: parsed.dropped });
    if (parsed.facts.length === 0 && parsed.ended.length === 0) return;
    const writes = planFactWrites(
      known,
      parsed.facts,
      { characterId: this.characterId, now: this.now().toISOString(), newId: this.newId, sourceEpisodeId },
      parsed.ended,
    );
    await this.apply(writes.upserts, writes.supersede, writes.expire);
  }

  /** Write a plan's changes and keep the cache in step with what was written. */
  private async apply(
    upserts: readonly SemanticFact[],
    supersede: readonly { readonly id: string; readonly validTo: string }[],
    expire: readonly { readonly id: string; readonly at: string }[],
  ): Promise<void> {
    const known = await this.loadKnown();
    const now = this.now().toISOString();
    // Closing first: a fact that replaces another is never briefly beside it.
    for (const { id, validTo } of supersede) {
      await this.options.store.supersedeFact(id, validTo);
      const fact = known.get(id);
      if (fact !== undefined && validTo <= now) known.delete(id);
      else if (fact !== undefined) known.set(id, { ...fact, validTo });
    }
    for (const { id, at } of expire) {
      await this.options.store.expireFact(id, at);
      known.delete(id);
    }
    const embeddings = await this.embed(upserts.map((fact) => `${fact.subject} ${fact.predicate} ${fact.object}`.replaceAll('_', ' ')));
    for (const [i, fact] of upserts.entries()) {
      await this.options.store.upsertFact({ ...fact, embedding: embeddings[i] ?? null });
      known.set(fact.id, { ...fact, embedding: null });
    }
  }
}
