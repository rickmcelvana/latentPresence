import type { Schedule } from '@latentpresence/protocol';
import { parseCron } from '../cron';
import { planSchedule } from '../plan';

/**
 * The cases both schedulers are held to (P6-T07b, ADR-57): the core's (`cron.ts`, TypeScript)
 * and the companion's (croner-rust). `pnpm schedule:fixtures` writes the core's answers to
 * `firings.json`; each side's test reads that file.
 */

export interface FiringCase {
  readonly name: string;
  readonly expression: string;
  readonly timeZone: string;
  /** Firings strictly after this. */
  readonly after: string;
  readonly count: number;
}

export const FIRING_CASES: readonly FiringCase[] = [
  { name: 'spring forward: a skipped 02:30 fires an hour later', expression: '30 2 * * *', timeZone: 'America/Toronto', after: '2026-03-07T12:00:00.000Z', count: 3 },
  { name: 'fall back: a repeated 01:30 fires once, the first', expression: '30 1 * * *', timeZone: 'America/Toronto', after: '2026-10-31T12:00:00.000Z', count: 3 },
  { name: 'every 30 minutes across fall back', expression: '*/30 * * * *', timeZone: 'America/Toronto', after: '2026-11-01T04:45:00.000Z', count: 6 },
  { name: 'every 30 minutes across spring forward', expression: '*/30 * * * *', timeZone: 'America/Toronto', after: '2026-03-08T06:15:00.000Z', count: 4 },
  { name: 'hourly across fall back', expression: '0 * * * *', timeZone: 'America/Toronto', after: '2026-11-01T03:30:00.000Z', count: 5 },
  { name: 'weekdays at 8 over a weekend', expression: '0 8 * * 1-5', timeZone: 'America/Toronto', after: '2026-10-09T13:00:00.000Z', count: 3 },
  { name: 'weekday names', expression: '0 9 * * MON,FRI', timeZone: 'America/Toronto', after: '2026-10-12T14:00:00.000Z', count: 3 },
  { name: 'day of month OR day of week', expression: '0 9 13 * 1', timeZone: 'America/Toronto', after: '2026-10-12T14:00:00.000Z', count: 3 },
  { name: 'strictly after a firing', expression: '0 9 * * *', timeZone: 'America/Toronto', after: '2026-10-13T13:00:00.000Z', count: 1 },
  { name: 'Helsinki across its October change', expression: '0 9 * * *', timeZone: 'Europe/Helsinki', after: '2026-10-24T00:00:00.000Z', count: 3 },
  { name: 'Sydney across its October change', expression: '15 3 * * 0', timeZone: 'Australia/Sydney', after: '2026-09-26T00:00:00.000Z', count: 3 },
  { name: 'first of the month, over a year end', expression: '0 0 1 * *', timeZone: 'UTC', after: '2026-12-15T00:00:00.000Z', count: 2 },
  { name: 'the 29th of February', expression: '0 12 29 2 *', timeZone: 'UTC', after: '2026-01-01T00:00:00.000Z', count: 1 },
  { name: 'every 15 minutes in working hours', expression: '*/15 9-17 * * 1-5', timeZone: 'America/Toronto', after: '2026-10-13T21:40:00.000Z', count: 3 },
];

/**
 * A seeded batch, for breadth (ADR-57): patterns of every shape, in zones with ordinary, half-hour
 * (Lord Howe) and quarter-hour (Chatham) offsets and changes, looked at near their clock changes
 * and at random through 2026–2028. Deterministic, so the file only changes when this list does.
 */
const PATTERNS = [
  '*/15 * * * *',
  '0 * * * *',
  '30 2 * * *',
  '0 3 * * *',
  '45 1 * * *',
  '0 0 * * *',
  '15 2,14 * * *',
  '*/20 1-3 * * *',
  '0 9 * * 1-5',
  '0 8 1,15 * *',
  '0 12 * JAN,JUL *',
  '5 4 * * SUN',
  '0 */6 * * *',
  '30 1 1 * 1',
  '0 2 * * *',
  '59 23 31 12 *',
  '10-20/5 2 * * *',
  '0 1-3 * * *',
];
const ZONES = ['America/Toronto', 'America/Los_Angeles', 'Europe/Helsinki', 'Europe/London', 'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Asia/Kolkata'];
/** Around each zone's 2026 clock changes (UTC), and some ordinary days. */
const NEAR_CHANGES = [
  '2026-03-07T20:00:00.000Z',
  '2026-03-08T05:00:00.000Z',
  '2026-03-28T22:00:00.000Z',
  '2026-03-29T00:30:00.000Z',
  '2026-04-04T13:00:00.000Z',
  '2026-04-04T15:00:00.000Z',
  '2026-09-26T13:00:00.000Z',
  '2026-10-03T14:00:00.000Z',
  '2026-10-03T15:30:00.000Z',
  '2026-10-24T22:00:00.000Z',
  '2026-10-25T00:30:00.000Z',
  '2026-10-31T23:00:00.000Z',
  '2026-11-01T05:30:00.000Z',
  '2026-11-01T08:30:00.000Z',
];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function generated(count: number): FiringCase[] {
  const random = seeded(57);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const cases: FiringCase[] = [];
  for (let i = 0; i < count; i += 1) {
    const near = random() < 0.6;
    const after = near
      ? new Date(Date.parse(pick(NEAR_CHANGES)) + Math.floor(random() * 12) * 15 * 60_000).toISOString()
      : new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 3 * 365 * 24 * 4) * 15 * 60_000).toISOString();
    const expression = pick(PATTERNS);
    const timeZone = pick(ZONES);
    cases.push({ name: `generated ${i + 1}: ${expression} in ${timeZone} after ${after}`, expression, timeZone, after, count: 4 });
  }
  return cases;
}

export const GENERATED_FIRING_CASES: readonly FiringCase[] = generated(240);

export function firingsOf(input: FiringCase): string[] {
  const cron = parseCron(input.expression, input.timeZone);
  const out: string[] = [];
  let cursor: Date | null = new Date(input.after);
  while (out.length < input.count) {
    cursor = cursor === null ? null : cron.next(cursor);
    if (cursor === null) break;
    out.push(cursor.toISOString());
  }
  return out;
}

/** A plan case: the schedule's trigger, policy and due time, and when it is looked at. */
export interface PlanCase {
  readonly name: string;
  readonly trigger: Schedule['trigger'];
  readonly catchUp: Schedule['catchUp'];
  readonly nextRunAt: string;
  readonly now: string;
}

const daily: Schedule['trigger'] = { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/Toronto' };
const hourly: Schedule['trigger'] = { kind: 'cron', expression: '0 * * * *', timeZone: 'America/Toronto' };

export const PLAN_CASES: readonly PlanCase[] = [
  { name: 'on time', trigger: daily, catchUp: 'skip', nextRunAt: '2026-10-13T13:00:00.000Z', now: '2026-10-13T13:01:00.000Z' },
  { name: 'late within the grace', trigger: daily, catchUp: 'skip', nextRunAt: '2026-10-13T13:00:00.000Z', now: '2026-10-13T13:05:00.000Z' },
  { name: 'not yet', trigger: daily, catchUp: 'run_all', nextRunAt: '2026-10-14T13:00:00.000Z', now: '2026-10-13T13:01:00.000Z' },
  { name: 'skip: missed three, one on time', trigger: daily, catchUp: 'skip', nextRunAt: '2026-10-10T13:00:00.000Z', now: '2026-10-13T13:01:00.000Z' },
  { name: 'skip: all missed', trigger: daily, catchUp: 'skip', nextRunAt: '2026-10-10T13:00:00.000Z', now: '2026-10-13T15:00:00.000Z' },
  { name: 'run_once: all missed', trigger: daily, catchUp: 'run_once', nextRunAt: '2026-10-10T13:00:00.000Z', now: '2026-10-13T15:00:00.000Z' },
  { name: 'run_all: three missed and one on time', trigger: daily, catchUp: 'run_all', nextRunAt: '2026-10-10T13:00:00.000Z', now: '2026-10-13T13:01:00.000Z' },
  { name: 'run_all: a day of hours, capped', trigger: hourly, catchUp: 'run_all', nextRunAt: '2026-10-12T00:00:00.000Z', now: '2026-10-13T00:30:00.000Z' },
  { name: 'a one-shot, missed, skipped', trigger: { kind: 'once', at: '2026-10-13T13:00:00.000Z' }, catchUp: 'skip', nextRunAt: '2026-10-13T13:00:00.000Z', now: '2026-10-13T18:00:00.000Z' },
  { name: 'a one-shot, missed, run once', trigger: { kind: 'once', at: '2026-10-13T13:00:00.000Z' }, catchUp: 'run_once', nextRunAt: '2026-10-13T13:00:00.000Z', now: '2026-10-13T18:00:00.000Z' },
  { name: 'hourly across fall back, caught up', trigger: hourly, catchUp: 'run_all', nextRunAt: '2026-11-01T03:00:00.000Z', now: '2026-11-01T08:30:00.000Z' },
];

export function planOf(input: PlanCase): { run: string[]; skipped: number; next: string | null } | null {
  const schedule = { trigger: input.trigger, catchUp: input.catchUp, nextRunAt: input.nextRunAt, status: 'active' } as Schedule;
  const plan = planSchedule(schedule, new Date(input.now));
  return plan === null ? null : { run: plan.run.map((time) => time.toISOString()), skipped: plan.skipped, next: plan.next?.toISOString() ?? null };
}
