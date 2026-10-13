import type { ScheduleTrigger } from '@latentpresence/protocol';

/**
 * When a schedule fires (P6-T07, ADR-56; rules ADR-57).
 *
 * **Five fields** — minute, hour, day of month, month, day of week — in the schedule's own IANA
 * zone: numbers, `*`, ranges `a-b`, steps `*\/s` and `a-b/s`, lists, and month and weekday names;
 * `?` is `*`. Day of month and day of week are OR'd when both are given, as in every cron people
 * know. A sixth field (seconds), `L`, `W`, `#` and unknown zones are refused in words.
 *
 * **Across a daylight-saving change** it follows the rules croner-rust (the companion's) and Vixie
 * cron do, and is held to croner-rust by `fixtures/firings.json`:
 *
 * - a **fixed-time** job (one minute, one hour) whose time the clocks skip runs at the first real
 *   instant after the gap (02:30 on the spring-forward night runs at 03:00), and one whose time
 *   happens twice runs once, the first time;
 * - an **interval** job (`*\/30`, every hour) follows real time: wall-clock times that do not exist
 *   are skipped, and times that happen twice run twice.
 *
 * Measured first (2026-10-13): croner 10.0.1, used for P6-T07, shifted a skipped fixed time by an
 * hour and ran interval jobs once in a repeated hour — an hourly job lost an hour — while
 * croner-rust 4.0.1 did as above. The core changed to match the companion, and the better rule.
 */

export class CronError extends Error {
  override readonly name = 'CronError';
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A pattern that never matches (the 31st of February) stops looking after this many days. */
const SEARCH_DAYS = 366 * 5;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface Field {
  readonly values: ReadonlySet<number>;
  /** `*` or `?`: every value, which for the days means "not restricted". */
  readonly any: boolean;
  /** One value, no range, list or step: with a single minute and hour, the job is fixed-time. */
  readonly single: boolean;
}

function fieldValue(part: string, name: string, names: readonly string[], nameBase: number): number {
  const named = names.indexOf(part.toUpperCase());
  if (named !== -1) return named + nameBase;
  if (!/^\d+$/u.test(part)) throw new CronError(`"${part}" is not a ${name}`);
  return Number(part);
}

function parseField(text: string, name: string, min: number, max: number, names: readonly string[] = [], nameBase = 0): Field {
  const values = new Set<number>();
  if (text === '*' || text === '?') {
    for (let n = min; n <= max; n += 1) values.add(n);
    return { values, any: true, single: false };
  }
  const parts = text.split(',');
  for (const part of parts) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`"${part}" has a step that is not a whole number above zero`);
    let from: number;
    let to: number;
    if (range === '*') {
      [from, to] = [min, max];
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      [from, to] = [fieldValue(a, name, names, nameBase), fieldValue(b, name, names, nameBase)];
    } else {
      if (stepText !== undefined) throw new CronError(`"${part}" steps from a single value; write "${range}-${max}/${stepText}"`);
      from = fieldValue(range, name, names, nameBase);
      to = from;
    }
    if (from < min || to > max || from > to) throw new CronError(`"${part}" is outside ${min}–${max} for the ${name}`);
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return { values, any: false, single: parts.length === 1 && !text.includes('-') && !text.includes('/') };
}

interface Pattern {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: Field;
  readonly months: Field;
  readonly weekdays: Field;
  readonly fixed: boolean;
}

function byNumber(a: number, b: number): number {
  return a - b;
}

function parsePattern(expression: string): Pattern {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw new CronError(`"${expression}" has ${fields.length} fields; a schedule takes five (minute hour day month weekday)`);
  if (/[LW#]/u.test(fields.slice(2).join(' ').replaceAll(/[A-Za-z]{3}/gu, ''))) throw new CronError(`"${expression}" uses L, W or #, which a schedule here does not take`);
  try {
    const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
    const minutes = parseField(minute, 'minute', 0, 59);
    const hours = parseField(hour, 'hour', 0, 23);
    const weekdays = parseField(weekday, 'weekday', 0, 7, WEEKDAYS);
    return {
      minutes: [...minutes.values].toSorted(byNumber),
      hours: [...hours.values].toSorted(byNumber),
      days: parseField(day, 'day of the month', 1, 31),
      months: parseField(month, 'month', 1, 12, MONTHS, 1),
      // 7 is Sunday too.
      weekdays: { ...weekdays, values: new Set([...weekdays.values].map((n) => n % 7)) },
      fixed: minutes.single && hours.single,
    };
  } catch (error) {
    if (error instanceof CronError) throw new CronError(`"${expression}" is not a schedule: ${error.message}`, { cause: error });
    throw error;
  }
}

function dayMatches(pattern: Pattern, midnight: number): boolean {
  const date = new Date(midnight);
  if (!pattern.months.values.has(date.getUTCMonth() + 1)) return false;
  const byDay = pattern.days.values.has(date.getUTCDate());
  const byWeekday = pattern.weekdays.values.has(date.getUTCDay());
  if (pattern.days.any && pattern.weekdays.any) return true;
  if (pattern.days.any) return byWeekday;
  if (pattern.weekdays.any) return byDay;
  return byDay || byWeekday;
}

/** Wall clock in a zone. */
class Zone {
  private readonly format: Intl.DateTimeFormat;

  constructor(name: string) {
    try {
      this.format = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch (error) {
      throw new CronError(`"${name}" is not a time zone this browser knows`, { cause: error });
    }
  }

  /** The wall clock at an instant, written as if it were UTC (so a difference is an offset). */
  wall(at: number): number {
    const parts: Record<string, number> = {};
    for (const part of this.format.formatToParts(new Date(at))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
    return Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  }

  /** Minutes ahead of UTC at an instant. */
  offset(at: number): number {
    const whole = Math.floor(at / 1000) * 1000;
    return (this.wall(whole) - whole) / MINUTE_MS;
  }

  /** The first instant (to the minute) with the later offset, between two with different ones. */
  transition(before: number, after: number): number {
    const from = this.offset(before);
    let [low, high] = [before, after];
    while (high - low > MINUTE_MS) {
      const mid = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
      if (this.offset(mid) === from) low = mid;
      else high = mid;
    }
    return high;
  }
}

/** A parsed five-field expression in a zone; `next(after)` is strictly after `after`. */
export interface CronTimes {
  next(after: Date): Date | null;
}

export function parseCron(expression: string, timeZone: string): CronTimes {
  const pattern = parsePattern(expression);
  const zone = new Zone(timeZone);

  /** The firings of one local day, in real order: the slow path, for a day the clocks change. */
  const changingDay = (midnight: number, offsets: readonly number[]): number[] => {
    const found: number[] = [];
    const [low = 0, high = 0] = offsets.toSorted((a, b) => a - b);
    for (const hour of pattern.hours) {
      for (const minute of pattern.minutes) {
        const wall = midnight + (hour * 60 + minute) * MINUTE_MS;
        const instants = [...new Set([wall - low * MINUTE_MS, wall - high * MINUTE_MS])].filter((at) => zone.wall(at) === wall).toSorted((a, b) => a - b);
        if (instants.length === 0) {
          // Skipped by the clocks: a fixed-time job runs at the first real instant after the gap.
          if (pattern.fixed) found.push(zone.transition(wall - high * MINUTE_MS, wall - low * MINUTE_MS));
        } else {
          // Twice: a fixed-time job runs the first time, an interval job both times.
          found.push(...(pattern.fixed ? instants.slice(0, 1) : instants));
        }
      }
    }
    return found.toSorted((a, b) => a - b);
  };

  const next = (after: Date): Date | null => {
    const from = after.getTime();
    const start = new Date(zone.wall(from));
    const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    for (let n = 0; n < SEARCH_DAYS; n += 1) {
      const midnight = first + n * DAY_MS;
      if (!dayMatches(pattern, midnight)) continue;
      // Offsets around this local day: one, unless the clocks change on it.
      const offsets = [...new Set([zone.offset(midnight - DAY_MS), zone.offset(midnight + 2 * DAY_MS)])];
      if (offsets.length > 1) {
        const at = changingDay(midnight, offsets).find((candidate) => candidate > from);
        if (at !== undefined) return new Date(at);
        continue;
      }
      const offset = (offsets[0] ?? 0) * MINUTE_MS;
      for (const hour of pattern.hours) {
        for (const minute of pattern.minutes) {
          const at = midnight + (hour * 60 + minute) * MINUTE_MS - offset;
          if (at > from) return new Date(at);
        }
      }
    }
    return null;
  };
  return { next };
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
