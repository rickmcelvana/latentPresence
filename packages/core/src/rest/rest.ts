import type { ConversationEvent, ConversationState, SemanticFact } from '@latentpresence/protocol';
import { Cancellation } from '../cancellation';
import type { Scheduler } from '../conversation/machine';
import type { SleepReport } from '../memory/kernel';

/**
 * Her rest (P6-T04, ADR-53): when it has been quiet long enough and there is something new in
 * memory to sort, she rests — visibly, eyes closed — and sleeps on it (`MemoryKernel.sleep`).
 * Anything happening wakes her: a sleep still running stops between steps.
 *
 * She stays resting after the sleep ends, until someone is there again; and she rests only when
 * there is something to sort — facts recorded since she last slept, which a `_sleep` system block
 * remembers across reloads — so a quiet page is not a page that is always asleep.
 */

export const REST_AFTER_MS = 10 * 60_000;
export const REST_TICK_MS = 30_000;
export const REST_BLOCK = '_sleep';

const QUIET_STATES: ReadonlySet<ConversationState> = new Set(['idle', 'listening']);

export interface AttachRestOptions {
  readonly kernel: { sleep(options: { readonly signal?: Cancellation }): Promise<SleepReport>; knownFacts(): Promise<SemanticFact[]> };
  /** They are typing, a voice panel or a permission prompt is open. */
  readonly blocked: () => boolean;
  /** When she last slept, ISO: the `_sleep` block. */
  readonly ledger?: { read(): string | null; write(text: string): Promise<void> };
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  readonly afterMs?: number;
  readonly tickMs?: number;
  readonly onSlept?: (report: SleepReport) => void;
  readonly onError?: (error: Error) => void;
}

export interface AttachedRest {
  resting(): boolean;
  /** A key or a press on the page: someone is there. */
  wake(): void;
  /** Ask once now whether to rest (the timer does this every `tickMs`); true if she lay down. */
  tick(): Promise<boolean>;
  /** Told whenever she lies down or wakes. */
  subscribe(listener: (resting: boolean) => void): () => void;
  detach(): void;
}

/** Something to sort: a fact recorded since she last slept (never slept: two or more facts). */
export function hasSomethingToSort(facts: readonly SemanticFact[], lastSlept: string | null): boolean {
  if (lastSlept === null) return facts.length >= 2;
  return facts.some((fact) => fact.recordedAt > lastSlept);
}

export function attachRest(machine: { subscribe: (listener: (event: ConversationEvent) => void) => () => void; getState: () => ConversationState }, options: AttachRestOptions): AttachedRest {
  const now = options.now ?? Date.now;
  const afterMs = options.afterMs ?? REST_AFTER_MS;
  const listeners = new Set<(resting: boolean) => void>();
  let lastActivity = now();
  let resting = false;
  let deciding = false;
  let sleeping: Cancellation | null = null;
  let timer: unknown = null;
  let detached = false;

  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const set = (next: boolean): void => {
    if (next === resting) return;
    resting = next;
    for (const listener of listeners) listener(next);
  };

  const wake = (): void => {
    lastActivity = now();
    sleeping?.abort();
    sleeping = null;
    set(false);
  };

  const unsubscribe = machine.subscribe((event) => {
    if (event.type === 'affect.user.updated' || event.type === 'affect.character.updated') return;
    wake();
  });

  const tick = async (): Promise<boolean> => {
    if (resting || deciding || detached) return false;
    if (now() - lastActivity < afterMs || !QUIET_STATES.has(machine.getState()) || options.blocked()) return false;
    deciding = true;
    const askedAt = lastActivity;
    try {
      const facts = await options.kernel.knownFacts();
      // Someone came back while she looked.
      if (lastActivity !== askedAt || !hasSomethingToSort(facts, options.ledger?.read() ?? null)) return false;
    } catch (error) {
      report(error);
      return false;
    } finally {
      deciding = false;
    }
    const wakeSignal = new Cancellation();
    sleeping = wakeSignal;
    const startedAt = new Date(now()).toISOString();
    set(true);
    void options.kernel
      .sleep({ signal: wakeSignal })
      .then(async (slept) => {
        options.onSlept?.(slept);
        // Stopped part way: the rest is for next time, so "last slept" stays where it was.
        if (!slept.stopped) await options.ledger?.write(startedAt);
      })
      .catch(report)
      .finally(() => {
        if (sleeping === wakeSignal) sleeping = null;
      });
    return true;
  };

  const schedule = (): void => {
    if (detached || options.scheduler === undefined) return;
    timer = options.scheduler.setTimeout(() => {
      void tick().finally(schedule);
    }, options.tickMs ?? REST_TICK_MS);
  };
  schedule();

  return {
    resting: () => resting,
    wake,
    tick,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    detach() {
      detached = true;
      unsubscribe();
      sleeping?.abort();
      if (timer !== null) options.scheduler?.clearTimeout(timer);
      listeners.clear();
    },
  };
}
