import type { MemoryStore, Schedule, ScheduleRun, ScheduleRunner } from '@latentpresence/protocol';
import type { Scheduler } from '../conversation/machine';
import type { ScheduleExecutor } from './execute';
import { planSchedule } from './plan';

/**
 * The schedules running where the core is awake (P6-T07, ADR-14, ADR-56): a fixed tick asks
 * `planSchedule` about every active schedule of this runner's, and runs what is due one at a
 * time. Waking — a page opened, a laptop opened, a throttled tab's late timer — is the same tick
 * finding firings in the past, which the catch-up policy settles.
 *
 * **A firing is claimed before it runs**: `nextRunAt` moves on (a one-shot becomes `completed`)
 * and is saved first, so a reload mid-run does not run it again. After it runs, the run is kept on
 * the schedule (`lastRun`), its summary goes into memory as an episode in the schedule's own
 * session, and the delivery is routed:
 *
 * - `silent_log` — told by being written down: `deliveredAt` at once;
 * - `notify` — the notifier, when there is one and it says it showed it; otherwise it waits to be
 *   said, as `speak_next_session` does, so nothing meant for them is lost;
 * - `speak_next_session` — waits (`deliveredAt` null) until she has said it: `pendingDeliveries`.
 *
 * A failed run is told as a failure. Missed firings the policy skips are kept as a `skipped` run
 * and told to nobody.
 */

export const SCHEDULER_TICK_MS = 30_000;

export interface AttachSchedulerOptions {
  readonly store: Pick<MemoryStore, 'listSchedules' | 'saveSchedule' | 'appendEpisode'>;
  readonly characterId: string;
  readonly execute: ScheduleExecutor;
  /** Shows a notification; true when it did. */
  readonly notify?: (schedule: Schedule, run: ScheduleRun) => Promise<boolean>;
  /** Whose schedules these are to run: the core's (default) or the companion's. */
  readonly runner?: ScheduleRunner;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  readonly tickMs?: number;
  readonly newId?: () => string;
  /** After every run is kept (a panel listens). */
  readonly onRun?: (schedule: Schedule, run: ScheduleRun) => void;
  readonly onError?: (error: Error) => void;
}

export interface AttachedScheduler {
  /** Look now (the timer does this every tick). Resolves when what was due has run. */
  tick(): Promise<void>;
  /**
   * Run one schedule once, now (P6-T08, ADR-58), through the same path as a due one — episode,
   * `lastRun`, `onRun` — **without moving its next run or its status**. It waits for a pass in
   * progress, never overlaps one, and its run is told at once: she reads it in the tool's reply and
   * says it herself. Null, and nothing run, when there is no such schedule, it is a companion tool
   * job (the companion's to run), or this is detached.
   */
  runNow(scheduleId: string): Promise<ScheduleRun | null>;
  detach(): void;
}

/** Session id of a schedule's episodes: its results are memories, never a conversation. */
export function scheduleSessionId(scheduleId: string): string {
  return `schedule-${scheduleId}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** What a failed run tells them. */
function failure(schedule: Schedule, error: string): string {
  return `I couldn't do "${schedule.description}": ${error}`;
}

export function attachScheduler(options: AttachSchedulerOptions): AttachedScheduler {
  const now = options.now ?? Date.now;
  const runner = options.runner ?? 'core';
  const tickMs = options.tickMs ?? SCHEDULER_TICK_MS;
  let count = 0;
  const newId = options.newId ?? (() => `run-${now().toString(36)}-${(count += 1).toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const report = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  let running: Promise<void> | null = null;
  let timer: unknown = null;
  let detached = false;


  /** Keep the run on the schedule as it is now (it may have been paused or edited meanwhile). */
  const keep = async (schedule: Schedule, run: ScheduleRun, failed: boolean, claimed = true): Promise<void> => {
    const current = (await options.store.listSchedules(options.characterId)).find((candidate) => candidate.id === schedule.id);
    if (current === undefined) return;
    // A run on demand is no firing: the schedule's status stays as it was.
    const status = claimed && failed && current.trigger.kind === 'once' && current.status === 'completed' ? 'failed' : current.status;
    const kept = { ...current, status, lastRunAt: run.startedAt, lastRun: run };
    await options.store.saveSchedule(kept);
    options.onRun?.(kept, run);
  };

  const deliver = async (schedule: Schedule, run: ScheduleRun): Promise<ScheduleRun> => {
    if (schedule.delivery === 'silent_log' || run.summary === '') return { ...run, deliveredAt: run.finishedAt };
    if (schedule.delivery === 'notify' && options.notify !== undefined) {
      try {
        if (await options.notify(schedule, run)) return { ...run, deliveredAt: iso(now()) };
      } catch (error) {
        report(error);
      }
    }
    return run;
  };

  const runOne = async (schedule: Schedule, scheduledFor: Date, onDemand = false): Promise<ScheduleRun> => {
    const startedAt = iso(now());
    const outcome = await options.execute(schedule, scheduledFor).catch((error: unknown) => ({ ok: false, summary: '', error: error instanceof Error ? error.message : String(error) }));
    const finishedAt = iso(now());
    const summary = outcome.ok ? outcome.summary : failure(schedule, outcome.error ?? 'it failed');
    const made: ScheduleRun = {
      id: newId(),
      scheduleId: schedule.id,
      startedAt,
      finishedAt,
      outcome: outcome.ok ? 'ok' : 'failed',
      summary,
      error: outcome.ok ? null : (outcome.error ?? 'it failed'),
      scheduledFor: scheduledFor.toISOString(),
      deliveredAt: null,
    };
    // On demand, she is about to say it herself (it is in the tool's reply): told already.
    const run = onDemand ? { ...made, deliveredAt: finishedAt } : await deliver(schedule, made);
    if (summary !== '') {
      await options.store.appendEpisode({
        id: `${run.id}-said`,
        sessionId: scheduleSessionId(schedule.id),
        characterId: options.characterId,
        role: 'assistant',
        text: summary,
        interrupted: false,
        at: finishedAt,
        embedding: null,
        affect: null,
      });
    }
    await keep(schedule, run, !outcome.ok, !onDemand);
    return run;
  };

  const pass = async (): Promise<void> => {
    const at = new Date(now());
    const schedules = await options.store.listSchedules(options.characterId);
    for (const schedule of schedules) {
      if (detached) return;
      if (schedule.runOn !== runner) continue;
      let plan;
      try {
        plan = planSchedule(schedule, at);
      } catch (error) {
        // A schedule that cannot be read (a zone this runtime does not know) fails, once.
        report(error);
        await options.store.saveSchedule({ ...schedule, status: 'failed', nextRunAt: null });
        continue;
      }
      if (plan === null) continue;
      const claimed: Schedule = { ...schedule, nextRunAt: plan.next?.toISOString() ?? null, status: plan.next === null ? 'completed' : schedule.status };
      await options.store.saveSchedule(claimed);
      for (const time of plan.run) {
        if (detached) return;
        await runOne(claimed, time);
      }
      if (plan.run.length === 0 && plan.skipped > 0) {
        const skippedAt = iso(now());
        await keep(
          claimed,
          { id: newId(), scheduleId: schedule.id, startedAt: skippedAt, finishedAt: skippedAt, outcome: 'skipped', summary: '', error: null, scheduledFor: schedule.nextRunAt, deliveredAt: skippedAt },
          false,
        );
      }
    }
  };

  /** One job at a time: a pass, or a run on demand queued behind whatever is in progress. */
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const result = (running ?? Promise.resolve()).then(job);
    const mine = result.then(
      () => undefined,
      () => undefined,
    );
    running = mine;
    void mine.then(() => {
      if (running === mine) running = null;
    });
    return result;
  };

  const tick = (): Promise<void> => running ?? exclusive(() => pass().catch(report));

  const runNow = (scheduleId: string): Promise<ScheduleRun | null> =>
    exclusive(async () => {
      if (detached) return null;
      const found = (await options.store.listSchedules(options.characterId)).find((candidate) => candidate.id === scheduleId);
      if (found === undefined || found.toolCall !== null) return null;
      return runOne(found, new Date(now()), true);
    });

  const schedule = (): void => {
    if (detached || options.scheduler === undefined) return;
    timer = options.scheduler.setTimeout(() => {
      void tick().finally(schedule);
    }, tickMs);
  };
  // Waking is a tick: whatever was due while nothing was awake is settled now.
  void tick().finally(schedule);

  return {
    tick,
    runNow,
    detach() {
      detached = true;
      if (timer !== null) options.scheduler?.clearTimeout(timer);
    },
  };
}

/** Runs she still has to tell them about, oldest first (`speak_next_session`, or a notification that could not be shown). */
export function pendingDeliveries(schedules: readonly Schedule[]): { readonly schedule: Schedule; readonly run: ScheduleRun }[] {
  return schedules
    .flatMap((schedule) => (schedule.lastRun !== null && schedule.lastRun.deliveredAt === null && schedule.lastRun.summary !== '' ? [{ schedule, run: schedule.lastRun }] : []))
    .toSorted((a, b) => Date.parse(a.run.finishedAt ?? a.run.startedAt) - Date.parse(b.run.finishedAt ?? b.run.startedAt));
}

/** The schedule with its last run marked told. */
export function markDelivered(schedule: Schedule, at: Date): Schedule {
  return schedule.lastRun === null ? schedule : { ...schedule, lastRun: { ...schedule.lastRun, deliveredAt: at.toISOString() } };
}
