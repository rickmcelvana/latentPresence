import type { Schedule } from '@latentpresence/protocol';
import { firingsBetween, nextFiring } from './cron';

/**
 * What to do about a schedule now (P6-T07, ADR-56) — pure, so a simulated week and a real tab
 * decide the same way.
 *
 * A firing found within `LATE_GRACE_MS` of its time is **on time** and runs whatever the policy:
 * a background tab's timers are throttled to about once a minute, and a reminder a minute late is
 * not a missed one. Older firings were **missed** — nothing was awake — and the catch-up policy
 * decides: `skip` runs none of them, `run_once` runs once for all of them (the newest), `run_all`
 * runs each, oldest first, at most `RUN_ALL_LIMIT`.
 */

/** Later than this, a firing was missed rather than late. */
export const LATE_GRACE_MS = 5 * 60_000;
/** `run_all` catches up at most this many; the rest are counted as skipped. */
export const RUN_ALL_LIMIT = 10;

export interface SchedulePlan {
  /** Firing times to run now, oldest first. */
  readonly run: readonly Date[];
  /** Missed firings not run (the policy, or past the limit). */
  readonly skipped: number;
  /** The next firing after now; null when there is none (a one-shot, done). */
  readonly next: Date | null;
}

/** Null when nothing is due: not active, not this runner's, or not yet. */
export function planSchedule(schedule: Schedule, now: Date): SchedulePlan | null {
  if (schedule.status !== 'active' || schedule.nextRunAt === null) return null;
  const due = new Date(schedule.nextRunAt);
  if (due.getTime() > now.getTime()) return null;
  const { times, more } = firingsBetween(schedule.trigger, due, now, 1000);
  const next = nextFiring(schedule.trigger, now);
  const onTime = times.filter((time) => now.getTime() - time.getTime() <= LATE_GRACE_MS);
  const missed = times.filter((time) => now.getTime() - time.getTime() > LATE_GRACE_MS);
  const missedCount = missed.length + (more ? 1 : 0);
  if (onTime.length > 0) {
    // On time runs; anything older, under any policy, is caught up only by `run_all`.
    if (schedule.catchUp !== 'run_all') return { run: onTime.slice(-1), skipped: missedCount, next };
    const caught = missed.slice(-Math.max(0, RUN_ALL_LIMIT - 1));
    return { run: [...caught, ...onTime.slice(-1)], skipped: missedCount - caught.length, next };
  }
  switch (schedule.catchUp) {
    case 'skip':
      return { run: [], skipped: missedCount, next };
    case 'run_once':
      return { run: missed.slice(-1), skipped: Math.max(0, missedCount - 1), next };
    case 'run_all': {
      const caught = missed.slice(-RUN_ALL_LIMIT);
      return { run: caught, skipped: missedCount - caught.length, next };
    }
    default:
      return null;
  }
}
