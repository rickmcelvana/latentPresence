import type { CancellationSignal, LLMProvider, LlmRequest, LlmStreamChunk, MemoryStore, SemanticFact } from '@latentpresence/protocol';
import { MemoryKernel, type ExtractionRecord } from '../kernel';
import { MERGE_MARKER } from '../sleep';
import { THIRTY_TURNS, type ScriptedExchange } from './thirty-turns';

/**
 * Runs a scripted conversation through a real `MemoryKernel` exactly the same way for the
 * live check and for the unit test: the clock is the exchange's own time, ids are a counter,
 * and each exchange is written before the next is heard. So a reply recorded live and
 * replayed here produces the same facts with the same ids — which is what lets a recorded
 * `replaces` point at the right fact.
 */
export async function replayConversation(options: {
  readonly store: MemoryStore;
  readonly llm: LLMProvider;
  readonly modelId: string;
  readonly characterId?: string;
  readonly exchanges?: readonly ScriptedExchange[];
  readonly onExtraction?: (record: ExtractionRecord) => void;
}): Promise<{ readonly kernel: MemoryKernel; readonly current: SemanticFact[]; readonly errors: string[] }> {
  let clock = new Date(0);
  let next = 0;
  const errors: string[] = [];
  const kernel = new MemoryKernel({
    store: options.store,
    characterId: options.characterId ?? 'alice',
    extractor: { llm: options.llm, modelId: options.modelId },
    now: () => clock,
    newId: () => {
      next += 1;
      return `fact-${next}`;
    },
    onError: (error, stage) => errors.push(`${stage}: ${error.message}`),
    ...(options.onExtraction === undefined ? {} : { onExtraction: options.onExtraction }),
  });
  for (const [index, exchange] of (options.exchanges ?? THIRTY_TURNS).entries()) {
    clock = new Date(exchange.at);
    const answeredAt = new Date(clock.getTime() + 5000).toISOString();
    kernel.remember({ id: `turn-${index}-u`, sessionId: exchange.session, role: 'user', text: exchange.user, interrupted: false, at: exchange.at, affect: null });
    kernel.remember({ id: `turn-${index}-a`, sessionId: exchange.session, role: 'assistant', text: exchange.assistant, interrupted: false, at: answeredAt, affect: null });
    await kernel.idle();
  }
  return { kernel, current: await options.store.currentFacts(options.characterId ?? 'alice'), errors };
}

/** Plays back recorded extraction replies in order; any request past the end is an error. */
export class RecordedLLM implements LLMProvider {
  readonly id = 'recorded-llm';
  readonly requests: LlmRequest[] = [];
  private readonly replies: readonly string[];

  constructor(replies: readonly string[]) {
    this.replies = replies;
  }

  async listModels(): Promise<never[]> {
    return [];
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const reply = this.replies[this.requests.length];
    this.requests.push(request);
    if (reply === undefined) throw new Error(`no recorded reply for extraction ${this.requests.length}`);
    yield { type: 'text-delta', text: reply };
    yield { type: 'finish', reason: 'stop', usage: null };
  }
}

/**
 * The long replay's evenings (P6-T04): each exchange remembered as `/chat` would, and after each
 * evening, half an hour later, a sleep — or none, to see what sleep changes. The count of current
 * facts after each evening is the done-when's curve.
 */
export async function replayEvenings(options: {
  readonly store: MemoryStore;
  readonly llm: LLMProvider;
  readonly modelId: string;
  readonly exchanges: readonly ScriptedExchange[];
  readonly sleep: boolean;
  readonly characterId?: string;
}): Promise<{ readonly counts: readonly { readonly evening: string; readonly exchanges: number; readonly facts: number }[]; readonly current: SemanticFact[]; readonly errors: string[] }> {
  const characterId = options.characterId ?? 'sam';
  let clock = new Date(0);
  let next = 0;
  const errors: string[] = [];
  const kernel = new MemoryKernel({
    store: options.store,
    characterId,
    extractor: { llm: options.llm, modelId: options.modelId },
    now: () => clock,
    newId: () => {
      next += 1;
      return `fact-${next}`;
    },
    onError: (error, stage) => errors.push(`${stage}: ${error.message}`),
  });
  const evenings = [...new Set(options.exchanges.map((exchange) => exchange.session))];
  const counts: { evening: string; exchanges: number; facts: number }[] = [];
  let heard = 0;
  for (const evening of evenings) {
    for (const exchange of options.exchanges.filter((candidate) => candidate.session === evening)) {
      clock = new Date(exchange.at);
      kernel.remember({ id: `turn-${heard}-u`, sessionId: evening, role: 'user', text: exchange.user, interrupted: false, at: exchange.at, affect: null });
      kernel.remember({ id: `turn-${heard}-a`, sessionId: evening, role: 'assistant', text: exchange.assistant, interrupted: false, at: new Date(clock.getTime() + 5000).toISOString(), affect: null });
      heard += 1;
      await kernel.idle();
    }
    if (options.sleep) {
      clock = new Date(clock.getTime() + 30 * 60_000);
      await kernel.sleep();
    }
    counts.push({ evening, exchanges: heard, facts: (await options.store.currentFacts(characterId)).length });
  }
  return { counts, current: await options.store.currentFacts(characterId), errors };
}

/** Plays back recorded replies by kind — extraction or merge — so a run without sleep can reuse a run with it. */
export class KindedRecordedLLM implements LLMProvider {
  readonly id = 'kinded-recorded-llm';
  readonly requests: LlmRequest[] = [];
  private readonly queues: Map<string, string[]>;

  constructor(replies: readonly { readonly kind: string; readonly reply: string }[]) {
    this.queues = new Map();
    for (const { kind, reply } of replies) this.queues.set(kind, [...(this.queues.get(kind) ?? []), reply]);
  }

  async listModels(): Promise<never[]> {
    return [];
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    const system = request.messages.find((message) => message.role === 'system');
    const kind = system !== undefined && 'content' in system && typeof system.content === 'string' && system.content.includes(MERGE_MARKER) ? 'merge' : 'extract';
    const reply = this.queues.get(kind)?.shift();
    if (reply === undefined) throw new Error(`no recorded ${kind} reply left`);
    yield { type: 'text-delta', text: reply };
    yield { type: 'finish', reason: 'stop', usage: null };
  }
}

/**
 * An extractor that ignores the known facts (P6-T04): for each line Sam says it writes the
 * line's facts in that line's own wording, every time — what a weaker model does, or two tabs
 * extracting at once. Merge requests go to `merges`: a real model live, its recording in a test.
 */
export class ForgetfulExtractor implements LLMProvider {
  readonly id = 'forgetful-extractor';
  readonly merges: LLMProvider;
  private readonly writes: ReadonlyMap<string, readonly (readonly [string, string, string])[]>;

  constructor(writes: ReadonlyMap<string, readonly (readonly [string, string, string])[]>, merges: LLMProvider) {
    this.writes = writes;
    this.merges = merges;
  }

  async listModels(): Promise<never[]> {
    return [];
  }

  async *stream(request: LlmRequest, options?: { readonly signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
    const system = request.messages.find((message) => message.role === 'system');
    if (system !== undefined && 'content' in system && typeof system.content === 'string' && system.content.includes(MERGE_MARKER)) {
      yield* this.merges.stream(request, options);
      return;
    }
    const user = request.messages.find((message) => message.role === 'user');
    const text = user !== undefined && 'content' in user && typeof user.content === 'string' ? user.content : '';
    const said = [...text.matchAll(/^Person: (.*)$/gmu)].map((match) => match[1] ?? '');
    const facts = said.flatMap((line) => this.writes.get(line) ?? []).map(([subject, predicate, object]) => ({ subject, predicate, object, confidence: 0.9, validFrom: null, replaces: null }));
    yield { type: 'text-delta', text: JSON.stringify({ facts, ended: [] }) };
    yield { type: 'finish', reason: 'stop', usage: null };
  }
}
