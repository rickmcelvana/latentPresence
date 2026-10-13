import type { ScheduleTrigger } from '@latentpresence/protocol';
import { Cron } from 'croner';

/**
 * When a schedule fires (P6-T07, ADR-56), on croner 10.0.1 (MIT, no dependencies).
 *
 * **Five fields only** — minute, hour, day of month, month, day of week — in the schedule's own
 * IANA zone. croner also takes a sixth field for seconds, which a person never means, so it is
 * refused here. Day of month and day of week are OR'd, as in every cron people know.
 *
 * Across a daylight-saving change (measured 2026-10-13, America/Toronto): a time the clocks skip
 * fires once, an hour later (02:30 on the spring-forward day runs at 03:30); a time that happens
 * twice fires once, the first time; an every-30-minutes job steps over both without a gap or a
 * repeat in wall-clock time.
 */

export class CronError extends Error {
  override readonly name = 'CronError';
}

/** A zone the runtime knows, or a `CronError` saying it does not. */
function checkZone(timeZone: string): void {
  try {
    Intl.DateTimeFormat('en', { timeZone }).resolvedOptions();
  } catch {
    throw new CronError(`"${timeZone}" is not a time zone this browser knows`);
  }
}

/** A parsed five-field expression in a zone; `next(after)` is strictly after `after`. */
export interface CronTimes {
  next(after: Date): Date | null;
}

export function parseCron(expression: string, timeZone: string): CronTimes {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw new CronError(`"${expression}" has ${fields.length} fields; a schedule takes five (minute hour day month weekday)`);
  checkZone(timeZone);
  let cron: Cron;
  try {
    cron = new Cron(fields.join(' '), { timezone: timeZone, paused: true, legacyMode: true });
  } catch (error) {
    throw new CronError(`"${expression}" is not a schedule: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { next: (after) => cron.nextRun(after) };
}

/** The first firing strictly after `after`, or null when there is none (a one-shot that has passed). */
export function nextFiring(trigger: ScheduleTrigger, after: Date): Date | null {
  if (trigger.kind === 'once') {
    const at = new Date(trigger.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  return parseCron(trigger.expression, trigger.timeZone).next(after);
}

/**
 * Every firing from `from` (inclusive) to `to` (inclusive), at most `limit`, and whether more were
 * left out. A one-shot has one.
 */
export function firingsBetween(trigger: ScheduleTrigger, from: Date, to: Date, limit: number): { readonly times: Date[]; readonly more: boolean } {
  const times: Date[] = [];
  if (trigger.kind === 'once') {
    const at = new Date(trigger.at);
    if (at.getTime() >= from.getTime() && at.getTime() <= to.getTime()) times.push(at);
    return { times, more: false };
  }
  const cron = parseCron(trigger.expression, trigger.timeZone);
  let cursor: Date | null = new Date(from.getTime() - 1);
  for (;;) {
    cursor = cursor === null ? null : cron.next(cursor);
    if (cursor === null || cursor.getTime() > to.getTime()) return { times, more: false };
    if (times.length === limit) return { times, more: true };
    times.push(cursor);
  }
}
