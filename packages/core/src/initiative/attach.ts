import type { ConversationEvent, ConversationState, PlanDocument, SemanticFact } from '@latentpresence/protocol';
import type { Scheduler } from '../conversation/machine';
import type { PromptPlans } from '../plan/plans';
import { shouldOpen, type LastConversation } from '../time/last';
import {
  decideInitiative,
  dueFollowUps,
  parseLedger,
  serializeLedger,
  thoughtTopics,
  withinBudget,
  type InitiativeDecision,
  type InitiativeDial,
  type InitiativeEntry,
  type InitiativeKind,
} from './initiative';

/**
 * Her initiative on the page's bus (P6-T03, ADR-52): it watches what happens, asks
 * `decideInitiative` every `tickMs`, and when there is something to say has the chat say it.
 * The opener (ADR-51) goes through it too, so it counts against the same budget and the dial's
 * "off" turns it off.
 */

/** What starts her turns: `ChatSession` is one. */
export interface InitiativeChat {
  open(): boolean;
  speakUp(cue: string): boolean;
}

/** Where the ledger lives: the `_initiative` system block, through `SelfNotes`. */
export interface InitiativeLedgerStore {
  read(): string | null;
  write(text: string): Promise<void>;
}

export interface AttachInitiativeOptions {
  readonly chat: InitiativeChat;
  readonly dial: () => InitiativeDial;
  /** They are typing, a voice panel or a permission prompt is open: the page knows these. */
  readonly blocked: () => boolean;
  readonly followUps: () => PromptPlans['followUps'];
  readonly plans: () => readonly PlanDocument[];
  readonly facts: () => readonly SemanticFact[];
  readonly ledger?: InitiativeLedgerStore;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  /** How often she asks herself; 15 s by default. */
  readonly tickMs?: number;
  readonly onError?: (error: Error) => void;
}

export interface AttachedInitiative {
  /** ADR-51's opener, if they came back after an hour and the dial and budget allow it. */
  open(since: LastConversation | null): boolean;
  /** Ask once now (the timer does this every `tickMs`). */
  tick(): InitiativeDecision | null;
  /** What she has started in the last 24 hours. */
  entries(): readonly InitiativeEntry[];
  detach(): void;
}

export const INITIATIVE_TICK_MS = 15_000;
export const INITIATIVE_BLOCK = '_initiative';

const QUIET_STATES: ReadonlySet<ConversationState> = new Set(['idle', 'listening']);

export function attachInitiative(
  machine: { subscribe: (listener: (event: ConversationEvent) => void) => () => void; getState: () => ConversationState },
  options: AttachInitiativeOptions,
): AttachedInitiative {
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? INITIATIVE_TICK_MS;
  let ledger: InitiativeEntry[] = parseLedger(options.ledger?.read() ?? null, now());
  let lastActivity = now();
  let speaking = false;
  let timer: unknown = null;
  let detached = false;

  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const persist = (): void => {
    const store = options.ledger;
    if (store !== undefined) void store.write(serializeLedger(ledger, now())).catch(report);
  };
  /** Her last turn of her own, from this visit or an earlier one, has had no answer. */
  const unanswered = (): boolean => ledger.at(-1)?.answered === false;
  const answered = (): void => {
    const last = ledger.at(-1);
    if (last === undefined || last.answered) return;
    ledger = [...ledger.slice(0, -1), { ...last, answered: true }];
    persist();
  };

  const unsubscribe = machine.subscribe((event) => {
    if (event.type === 'affect.user.updated' || event.type === 'affect.character.updated') return;
    lastActivity = now();
    switch (event.type) {
      case 'user.speech.started':
        speaking = true;
        return;
      case 'user.turn.ended':
      case 'user.message':
        speaking = false;
        answered();
        return;
      case 'session.ended':
        speaking = false;
        return;
      default:
    }
  });

  const record = (kind: InitiativeKind, key: string | null): void => {
    ledger = [...ledger, { at: now(), kind, key, answered: false }];
    persist();
  };

  const tick = (): InitiativeDecision | null => {
    const at = now();
    const dial = options.dial();
    if (dial === 'off') return null;
    const date = new Date(at);
    const decision = decideInitiative({
      now: date,
      dial,
      ledger,
      quietMs: at - lastActivity,
      blocked: speaking || !QUIET_STATES.has(machine.getState()) || options.blocked(),
      unanswered: unanswered(),
      followUps: dueFollowUps(options.followUps(), date),
      thoughts: thoughtTopics(options.plans(), options.facts()),
    });
    if (decision === null || !options.chat.speakUp(decision.cue)) return null;
    record(decision.kind, decision.key);
    return decision;
  };

  const schedule = (): void => {
    if (detached || options.scheduler === undefined) return;
    timer = options.scheduler.setTimeout(() => {
      try {
        tick();
      } catch (error) {
        report(error);
      }
      schedule();
    }, tickMs);
  };
  schedule();

  return {
    // Not held to "one unanswered at a time": coming back to the page is their answer.
    open(since) {
      const at = now();
      if (options.dial() === 'off' || !shouldOpen(since, new Date(at)) || !withinBudget(options.dial(), ledger, at) || options.blocked()) return false;
      if (!options.chat.open()) return false;
      // The opener picks up a due follow-up first (ADR-51), so that one is raised.
      record('opener', dueFollowUps(options.followUps(), new Date(at))[0]?.key ?? null);
      return true;
    },
    tick,
    entries: () => ledger,
    detach() {
      detached = true;
      unsubscribe();
      if (timer !== null) options.scheduler?.clearTimeout(timer);
    },
  };
}
