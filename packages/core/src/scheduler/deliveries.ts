import type { ConversationState, Schedule, ScheduleRun } from '@latentpresence/protocol';
import type { Scheduler } from '../conversation/machine';
import { QUIET_STATES, type InitiativeChat } from '../initiative/attach';
import { LATE_GRACE_MS } from './plan';
import { SCHEDULER_TICK_MS, pendingDeliveries } from './runner';
import type { Schedules } from './schedules';
import { dueWords } from './words';

/**
 * Telling them what a schedule did (P6-T08, ADR-58 decision 5): the runs the scheduler kept and
 * nobody has been told of (`pendingDeliveries`) are said on opening and on every tick.
 *
 * - **Page hidden**: a `notify` run goes to the notifier (an OS notification); shown is told.
 * - **Page showing and she is free** (nothing typed, no voice panel or permission prompt open, the
 *   machine quiet): she says them, in one turn, and they are told.
 * - Otherwise they wait, and the next tick looks again.
 *
 * **Outside the initiative dial and budget**: they asked for it, so the dial's "off" does not
 * silence a reminder and a delivery is not counted as her starting a conversation. Nothing here
 * touches the initiative ledger.
 */

export interface AttachDeliveriesOptions {
  readonly schedules: Schedules;
  readonly chat: Pick<InitiativeChat, 'speakUp'>;
  /** They are typing, a voice panel or a permission prompt is open: the page knows these (initiative's own). */
  readonly blocked: () => boolean;
  /** The page is showing; hidden is when a notification is worth showing. */
  readonly visible: () => boolean;
  /** Shows an OS notification; true when it did. */
  readonly notify?: (schedule: Schedule, run: ScheduleRun) => Promise<boolean>;
  /** The person's zone, for saying when a late one was due. */
  readonly timeZone: string;
  readonly scheduler?: Scheduler;
  readonly tickMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
}

export interface AttachedDeliveries {
  /** Look now (the timer does this every tick); true when she said something. Never overlaps itself. */
  tick(): Promise<boolean>;
  detach(): void;
}

interface Item {
  readonly schedule: Schedule;
  readonly run: ScheduleRun;
}

/** A summary as the end of a sentence: one full stop, not two. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** One thing to tell, as a sentence, and what to ask of her about it. */
function describe(item: Item, now: Date, timeZone: string): { readonly text: string; readonly ask: string } {
  const { schedule, run } = item;
  const due = run.scheduledFor === null ? null : new Date(run.scheduledFor);
  const late = due !== null && now.getTime() - due.getTime() > LATE_GRACE_MS ? ` It was due ${dueWords(due, now, timeZone)}, while they were away — say so.` : '';
  if (schedule.taskPrompt.trim() === '') {
    return {
      text: `They asked you to remind them about this${late === '' ? ', and it is time now' : ''}: "${schedule.description}".${late}`,
      ask: 'Remind them in one or two short sentences, the way a friend would.',
    };
  }
  const did = run.outcome === 'failed' ? 'Something you tried to do for them on a schedule did not work' : 'Something you did for them on a schedule finished';
  return { text: `${did} — "${schedule.description}": ${sentence(run.summary)}${late}`, ask: 'Tell them in a sentence or two.' };
}

/**
 * The hidden turn that makes her say them, in the voice of `initiativeCue`: parenthesised, naming
 * why she is speaking and how to say it. A late one says when it was due; a failed run's summary
 * already says it failed (`runner.ts`) and is passed through; several are one numbered cue.
 */
export function deliveryCue(items: readonly Item[], now: Date, timeZone: string): string {
  const described = items.map((item) => describe(item, now, timeZone));
  const [only] = described;
  if (described.length === 1 && only !== undefined) return `(${only.text} ${only.ask})`;
  return `(Several things they asked you for are due. Tell them in one short turn, the way a friend would, a sentence for each:\n${described.map((item, index) => `${index + 1}. ${item.text}`).join('\n')})`;
}

export function attachDeliveries(machine: { getState(): ConversationState }, options: AttachDeliveriesOptions): AttachedDeliveries {
  const now = options.now ?? (() => new Date());
  const tickMs = options.tickMs ?? SCHEDULER_TICK_MS;
  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  let running: Promise<boolean> | null = null;
  let timer: unknown = null;
  let detached = false;

  const pass = async (): Promise<boolean> => {
    await options.schedules.load();
    const pending = pendingDeliveries(options.schedules.snapshot());
    if (pending.length === 0) return false;
    if (!options.visible()) {
      // Away from the page: a notification, if they allow one. Whatever it cannot show waits.
      const shown: string[] = [];
      for (const item of pending) {
        if (item.schedule.delivery !== 'notify' || options.notify === undefined) continue;
        try {
          if (await options.notify(item.schedule, item.run)) shown.push(item.schedule.id);
        } catch (error) {
          report(error);
        }
      }
      if (shown.length > 0) await options.schedules.markDelivered(shown, now());
      return false;
    }
    if (options.blocked() || !QUIET_STATES.has(machine.getState())) return false;
    if (!options.chat.speakUp(deliveryCue(pending, now(), options.timeZone))) return false;
    // She has said it; failing to write that down must not read as "not told", or she would say it again.
    await options.schedules
      .markDelivered(
        pending.map((item) => item.schedule.id),
        now(),
      )
      .catch(report);
    return true;
  };

  const tick = (): Promise<boolean> => {
    if (running !== null) return running;
    running = pass()
      .catch((error: unknown) => {
        report(error);
        return false;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const schedule = (): void => {
    if (detached || options.scheduler === undefined) return;
    timer = options.scheduler.setTimeout(() => {
      void tick().finally(schedule);
    }, tickMs);
  };
  schedule();

  return {
    tick,
    detach() {
      detached = true;
      if (timer !== null) options.scheduler?.clearTimeout(timer);
    },
  };
}
