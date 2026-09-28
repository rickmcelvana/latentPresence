import type { ConversationEvent, MemoryEpisode, PromptContext, SemanticFact, UserAffect } from '@latentpresence/protocol';
import type { MemoryKernel } from './kernel';

/** What the prompt carries (`PromptContext.memory`). */
export type PromptMemory = NonNullable<PromptContext['memory']>;

/**
 * Memory in the call (P4-T04b, ADR-38): a `MemoryKernel` fed by the conversation bus, and a
 * memory note the system prompt reads **synchronously**.
 *
 * **Nothing on the speaking path waits for a database.** A request is built the moment a turn
 * ends — before it is even confirmed, on the spoken path (ADR-25) — and `renderSystemPrompt` is
 * a plain function. So the note is kept ready instead: the facts she believes come from the
 * kernel's in-process cache (ADR-37), and past turns are recalled in the background after each
 * user message. The answer to a message therefore uses the recall made for the message before
 * it — one turn behind, which for "what did we talk about last week" costs a sentence, and for
 * facts costs nothing: they are all there from the first turn.
 *
 * **What is written** is what happened: each user message, with the fused affect at the time
 * (P3-T07); each answer as the user **heard** it — an interrupted one is its spoken prefix,
 * marked `interrupted` (P1-T12b). Backchannels are not turns and are not kept.
 */
export interface AttachMemoryOptions {
  readonly kernel: MemoryKernel;
  /** This visit's session: recall leaves it out, since the history already carries it. */
  readonly sessionId: string;
  /** How the user seems right now, stored with their turn; omitted, turns carry none. */
  readonly userAffect?: () => UserAffect | null;
  /** How many facts the prompt carries at most: the recalled ones first, then the surest. */
  readonly maxFacts?: number;
  readonly newId?: () => string;
  /** A recall or cache refresh failed; the note keeps what it had. */
  readonly onError?: (error: Error) => void;
}

export interface AttachedMemory {
  /** The note for the next request, or null while there is nothing to say. Never waits. */
  context(): PromptMemory | null;
  /** Resolves once every write queued so far and the refresh after it are done. For tests and shutdown. */
  settled(): Promise<void>;
  detach(): void;
}

export const DEFAULT_PROMPT_FACTS = 24;

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `turn-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The recalled facts first, in their order, then the rest by confidence and then the most
 * recently learned. `known` is the truth: a recalled fact the kernel has since closed is left
 * out, and one it has since reinforced is taken in its current form.
 */
export function promptFacts(recalled: readonly SemanticFact[], known: readonly SemanticFact[], max: number): SemanticFact[] {
  const current = new Map(known.map((fact) => [fact.id, fact]));
  const first = recalled.flatMap((fact) => current.get(fact.id) ?? []);
  const seen = new Set(first.map((fact) => fact.id));
  const rest = known
    .filter((fact) => !seen.has(fact.id))
    .toSorted((a, b) => b.confidence - a.confidence || Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  return [...first, ...rest].slice(0, max);
}

export function attachMemory(
  machine: { subscribe: (listener: (event: ConversationEvent) => void) => () => void },
  options: AttachMemoryOptions,
): AttachedMemory {
  const { kernel, sessionId } = options;
  const newId = options.newId ?? defaultId;
  const maxFacts = options.maxFacts ?? DEFAULT_PROMPT_FACTS;

  let known: readonly SemanticFact[] = [];
  let recalledFacts: readonly SemanticFact[] = [];
  let episodes: readonly MemoryEpisode[] = [];
  // A later refresh wins: an older one that resolves after it must not overwrite what it found.
  // Facts and recall count separately, so re-reading the facts after an answer does not
  // throw away a recall still in flight for the message before it.
  let factsGeneration = 0;
  let recallGeneration = 0;
  let pending: Promise<void> = Promise.resolve();

  const report = (error: unknown): void => options.onError?.(asError(error));

  const refresh = (query: string | null): void => {
    factsGeneration += 1;
    const factsTurn = factsGeneration;
    const hasQuery = query !== null && query.trim() !== '';
    if (hasQuery) recallGeneration += 1;
    const recallTurn = recallGeneration;
    const work = (async () => {
      // Facts after the writes queued so far, so a fact learned in the last exchange is in.
      try {
        await kernel.idle();
        const facts = await kernel.knownFacts();
        if (factsTurn === factsGeneration) known = facts;
      } catch (error) {
        report(error);
      }
      if (!hasQuery) return;
      try {
        const recalled = await kernel.recall({ sessionId, query: query ?? '' });
        if (recallTurn !== recallGeneration) return;
        recalledFacts = recalled.facts;
        episodes = recalled.episodes;
      } catch (error) {
        report(error);
      }
    })();
    pending = Promise.all([pending, work]).then(() => undefined);
  };

  const unsubscribe = machine.subscribe((event) => {
    const at = event.at;
    if (event.type === 'user.message') {
      const said = event.text.trim();
      if (said === '') return;
      kernel.remember({ id: newId(), sessionId, role: 'user', text: said, interrupted: false, at, affect: options.userAffect?.() ?? null });
      refresh(said);
      return;
    }
    if (event.type === 'assistant.message') {
      // Trimmed: a model's answer can arrive with the blank lines its reasoning left (glm, 2026-09-28).
      const heard = (event.entry.spokenPrefix ?? event.entry.text).trim();
      if (heard.trim() === '') return;
      kernel.remember({ id: newId(), sessionId, role: 'assistant', text: heard, interrupted: event.entry.spokenPrefix !== null, at, affect: null });
      // Extraction runs after the answer; the cache is re-read once it has, keeping the recall.
      refresh(null);
    }
  });

  refresh(null);

  return {
    context() {
      const facts = promptFacts(recalledFacts, known, maxFacts);
      return facts.length === 0 && episodes.length === 0 ? null : { facts, episodes: [...episodes] };
    },
    settled: () => pending,
    detach: unsubscribe,
  };
}
