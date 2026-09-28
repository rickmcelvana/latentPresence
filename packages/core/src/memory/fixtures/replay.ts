import type { LLMProvider, LlmRequest, LlmStreamChunk, MemoryStore, SemanticFact } from '@latentpresence/protocol';
import { MemoryKernel, type ExtractionRecord } from '../kernel';
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
