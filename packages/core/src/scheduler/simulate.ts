import type { Schedule, ScheduleRun } from '@latentpresence/protocol';
import { FakeMemoryStore } from '../memory/fake-store';
import { nextFiring } from './cron';
import type { ScheduleExecutor } from './execute';
import { SCHEDULER_TICK_MS, attachScheduler, markDelivered, pendingDeliveries, type AttachedScheduler } from './runner';

/**
 * A simulated week of schedules (P6-T07's done-when, ADR-56): Thursday 29 October to Thursday
 * 5 November 2026 in Toronto — across the night the clocks go back — with the page open by day,
 * closed at night, away all Saturday, then left open from Saturday night to Sunday night. The
 * real `attachScheduler` runs on a stepped clock and a `FakeMemoryStore`; a person "comes back"
 * when the page opens and on every hour while it is open, and is told what is waiting.
 *
 * Deterministic: the same week gives the same log, line for line.
 */

export const WEEK_ZONE = 'America/Toronto';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 2026-11-01 02:00 EDT becomes 01:00 EST: 06:00 UTC. */
const FALL_BACK = Date.UTC(2026, 10, 1, 6);

/** A Toronto wall-clock time this week, as UTC ms (never one of the repeated hour's times). */
export function toronto(month: number, day: number, hour: number, minute = 0): number {
  const edt = Date.UTC(2026, month - 1, day, hour + 4, minute);
  return edt >= FALL_BACK ? edt + HOUR : edt;
}

const LOCAL = new Intl.DateTimeFormat('en-CA', { timeZone: WEEK_ZONE, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });

export function localTime(ms: number): string {
  return LOCAL.format(new Date(ms)).replaceAll(',', '');
}

/** When the page is open: by day, away Saturday, open overnight Saturday to Sunday. */
export const OPEN: readonly (readonly [number, number])[] = [
  [toronto(10, 29, 8), toronto(10, 29, 23)],
  [toronto(10, 30, 8), toronto(10, 30, 23)],
  [toronto(10, 31, 23), toronto(11, 1, 23)],
  [toronto(11, 2, 8), toronto(11, 2, 23)],
  [toronto(11, 3, 8), toronto(11, 3, 23)],
  [toronto(11, 4, 8), toronto(11, 4, 23)],
];
/** The week has under two hundred runs; ten times that is a runner gone wrong. */
const RUNAWAY_RUNS = 2000;
export const WEEK_START = toronto(10, 29, 0);
export const WEEK_END = toronto(11, 5, 0);

function base(id: string, description: string, overrides: Partial<Schedule>): Schedule {
  const schedule: Schedule = {
    id,
    characterId: 'alice',
    description,
    trigger: { kind: 'cron', expression: '0 8 * * *', timeZone: WEEK_ZONE },
    taskPrompt: '',
    allowedTools: [],
    delivery: 'speak_next_session',
    catchUp: 'run_once',
    runOn: 'core',
    status: 'active',
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date(WEEK_START - HOUR).toISOString(),
    lastRun: null,
    ...overrides,
  };
  return { ...schedule, nextRunAt: nextFiring(schedule.trigger, new Date(WEEK_START - 1))?.toISOString() ?? null };
}

const once = (month: number, day: number, hour: number, minute = 0): Schedule['trigger'] => ({ kind: 'once', at: new Date(toronto(month, day, hour, minute)).toISOString() });
const cron = (expression: string): Schedule['trigger'] => ({ kind: 'cron', expression, timeZone: WEEK_ZONE });

/** The week's schedules: every policy, every delivery, a failure, a paused one, and the clock change. */
export function weekSchedules(): Schedule[] {
  return [
    base('morning', 'Morning summary', { trigger: cron('0 8 * * 1-5'), taskPrompt: 'Summarise what is on today.', catchUp: 'run_once' }),
    base('plants', 'Water the plants', { trigger: once(10, 31, 10), catchUp: 'run_once' }),
    base('standup', 'Stand-up call at 9:30', { trigger: once(11, 2, 9, 30), catchUp: 'skip', delivery: 'notify' }),
    base('bins', 'Put the bins out', { trigger: once(11, 4, 7), catchUp: 'run_once', delivery: 'notify' }),
    base('reindex', 'Re-index the notes folder', { trigger: cron('0 3 * * *'), taskPrompt: 'Re-index the notes.', catchUp: 'run_all', delivery: 'silent_log' }),
    base('feeds', 'Check the feeds', { trigger: cron('0 * * * *'), taskPrompt: 'Check the feeds.', catchUp: 'run_all', delivery: 'silent_log' }),
    base('night', 'Night check', { trigger: cron('30 1 * * *'), taskPrompt: 'Night check.', catchUp: 'skip', delivery: 'silent_log' }),
    base('paused', 'An old job, paused', { trigger: cron('*/15 * * * *'), taskPrompt: 'Nothing.', status: 'paused' }),
  ];
}

/** Does each job; the morning summary fails on Tuesday (its source is down). */
export const weekExecutor: ScheduleExecutor = async (schedule, scheduledFor) => {
  if (schedule.taskPrompt === '') return { ok: true, summary: schedule.description, error: null };
  if (schedule.id === 'morning' && localTime(scheduledFor.getTime()).startsWith('Tue')) return { ok: false, summary: '', error: 'the calendar did not answer' };
  return { ok: true, summary: `${schedule.description}, for ${localTime(scheduledFor.getTime())}: done.`, error: null };
};

export interface WeekResult {
  readonly log: readonly string[];
  readonly runs: readonly ScheduleRun[];
  /** Summaries she said, with when. */
  readonly said: readonly { readonly at: number; readonly scheduleId: string; readonly summary: string }[];
  readonly notified: readonly string[];
  readonly schedules: readonly Schedule[];
  readonly episodes: number;
}

export async function simulateScheduleWeek(): Promise<WeekResult> {
  const store = new FakeMemoryStore();
  for (const schedule of weekSchedules()) await store.saveSchedule(schedule);
  let episodes = 0;
  const append = store.appendEpisode.bind(store);
  store.appendEpisode = async (episode) => {
    episodes += 1;
    await append(episode);
  };
  const log: string[] = [];
  const runs: ScheduleRun[] = [];
  const said: { at: number; scheduleId: string; summary: string }[] = [];
  const notified: string[] = [];
  let ids = 0;
  let now = WEEK_START;
  let attached: AttachedScheduler | null = null;

  const tell = async (): Promise<void> => {
    const schedules = await store.listSchedules('alice');
    for (const { schedule, run } of pendingDeliveries(schedules)) {
      said.push({ at: now, scheduleId: schedule.id, summary: run.summary });
      log.push(`${localTime(now)}  said       ${run.summary}`);
      await store.saveSchedule(markDelivered(schedule, new Date(now)));
    }
  };

  const open = (): AttachedScheduler => {
    log.push(`${localTime(now)}  page opened`);
    // No timer of its own here: the week steps the fixed tick itself and awaits each one.
    return attachScheduler({
      store,
      characterId: 'alice',
      execute: weekExecutor,
      // Notifications work, except on Wednesday (blocked in the browser that day).
      notify: async (_schedule, run) => {
        if (localTime(now).startsWith('Wed')) return false;
        notified.push(`${localTime(now)} ${run.summary}`);
        log.push(`${localTime(now)}  notified   ${run.summary}`);
        return true;
      },
      now: () => now,
      newId: () => `run-${(ids += 1)}`,
      onRun: (schedule, run) => {
        runs.push(run);
        const late = run.scheduledFor === null ? '' : ` (due ${localTime(Date.parse(run.scheduledFor))})`;
        const told = run.deliveredAt === null ? 'to tell' : schedule.delivery === 'silent_log' || run.summary === '' ? 'logged' : 'told';
        log.push(`${localTime(now)}  ${run.outcome.padEnd(9)}  ${schedule.description}${late} — ${told}`);
      },
    });
  };

  // Open at each window's start, closed at its end; they come back when it opens and on the hour.
  for (now = WEEK_START; now <= WEEK_END; now += SCHEDULER_TICK_MS) {
    const window = OPEN.find(([from, to]) => now >= from && now < to);
    if (window === undefined) {
      if (attached !== null) {
        attached.detach();
        attached = null;
        log.push(`${localTime(now)}  page closed`);
      }
      continue;
    }
    // A runner that re-runs what it already ran would loop here for hours; fail it instead.
    if (runs.length > RUNAWAY_RUNS) throw new Error(`more than ${RUNAWAY_RUNS} runs in a week: something runs again and again`);
    const opening = attached === null;
    attached ??= open();
    await attached.tick();
    if (opening || (now - window[0]) % HOUR === 0) await tell();
  }
  return { log, runs, said, notified, schedules: await store.listSchedules('alice'), episodes };
}
