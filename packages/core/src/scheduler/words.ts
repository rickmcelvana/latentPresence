/**
 * A time and a repeat in words she can say back (P6-T08, ADR-58). Fixed English, not the
 * machine's locale: the reply to `schedule_create` is what she reads out, and it must be the
 * same on every machine and in every test. The person's own zone decides the day and the hour.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES =['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Parts {
  readonly weekday: string;
  readonly day: number;
  readonly month: string;
  readonly year: number;
  readonly hour: string;
  readonly minute: string;
}

function partsOf(at: Date, timeZone: string): Parts {
  const found = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string => found.find((part) => part.type === type)?.value ?? '';
  return { weekday: get('weekday'), day: Number(get('day')), month: get('month'), year: Number(get('year')), hour: get('hour'), minute: get('minute') };
}

/** The calendar day of a set of parts, as a number of days: two of these differ by whole days, whatever the clocks did. */
function dayNumber(parts: Parts): number {
  return Math.round(Date.UTC(parts.year, MONTH_NAMES.indexOf(parts.month), parts.day) / DAY_MS);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "3 hours", "2 hours and 5 minutes", "1 day and 23 hours": the two largest parts, zero ones dropped. */
function distance(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return plural(minutes, 'minute');
  const join = (big: number, bigUnit: string, small: number, smallUnit: string): string =>
    small === 0 ? plural(big, bigUnit) : `${plural(big, bigUnit)} and ${plural(small, smallUnit)}`;
  if (minutes < 24 * 60) return join(Math.floor(minutes / 60), 'hour', minutes % 60, 'minute');
  const hours = Math.round(minutes / 60);
  return join(Math.floor(hours / 24), 'day', hours % 24, 'hour');
}

/** `Thursday 15 October`, with the year only when it is not `now`'s. */
function dateWords(parts: Parts, now: Parts): string {
  return `${parts.weekday} ${parts.day} ${parts.month}${parts.year === now.year ? '' : ` ${parts.year}`}`;
}

/**
 * The next run as she should say it back: `today at 21:00 (in 3 hours)`, `tomorrow at 09:00 (in
 * 14 hours)`, `Thursday 15 October at 09:00 (in 1 day and 23 hours)`. "Today" and "tomorrow" are
 * the date in `timeZone`. A time not after `now` is `now`.
 */
export function whenWords(at: Date, now: Date, timeZone: string): string {
  const target = partsOf(at, timeZone);
  const current = partsOf(now, timeZone);
  const days = dayNumber(target) - dayNumber(current);
  const time = `${target.hour}:${target.minute}`;
  const gap = at.getTime() - now.getTime();
  const away = gap <= 0 ? 'now' : `in ${distance(gap)}`;
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : dateWords(target, current);
  return `${day} at ${time} (${away})`;
}

/**
 * A time that has gone by, in the past tense for a late reminder: `at 09:00 this morning`,
 * `at 18:30 yesterday`, `on Thursday 15 October at 09:00`.
 */
export function dueWords(at: Date, now: Date, timeZone: string): string {
  const target = partsOf(at, timeZone);
  const current = partsOf(now, timeZone);
  const days = dayNumber(current) - dayNumber(target);
  const time = `${target.hour}:${target.minute}`;
  if (days === 0) {
    const hour = Number(target.hour);
    return `at ${time} ${hour < 12 ? 'this morning' : hour < 18 ? 'this afternoon' : 'this evening'}`;
  }
  if (days === 1) return `at ${time} yesterday`;
  return `on ${dateWords(target, current)} at ${time}`;
}

/** "Thursday 15 October at 09:00" with no distance: the plain clock, for saying what time it is now. */
export function clockWords(at: Date, now: Date, timeZone: string): string {
  const target = partsOf(at, timeZone);
  return `${dateWords(target, partsOf(now, timeZone))} at ${target.hour}:${target.minute}`;
}

const TWO_DIGITS = (n: string): string => n.padStart(2, '0');

/**
 * The common repeats in words: `every day at 09:00`, `weekdays at 07:30`, `every Sunday at 18:00`,
 * `every 15 minutes`. Anything else is null, and the caller shows the expression itself.
 */
export function repeatWords(expression: string): string | null {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return null;
  const [minute = '', hour = '', dayOfMonth, month, dayOfWeek = ''] = fields;
  const step = /^\*\/(\d{1,2})$/u.exec(minute);
  if (step !== null && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = Number(step[1]);
    return n < 1 || n > 59 ? null : n === 1 ? 'every minute' : `every ${n} minutes`;
  }
  if (!/^\d{1,2}$/u.test(minute) || !/^\d{1,2}$/u.test(hour) || dayOfMonth !== '*' || month !== '*') return null;
  if (Number(minute) > 59 || Number(hour) > 23) return null;
  const time = `${TWO_DIGITS(hour)}:${TWO_DIGITS(minute)}`;
  if (dayOfWeek === '*') return `every day at ${time}`;
  if (dayOfWeek === '1-5') return `weekdays at ${time}`;
  if (/^[0-7]$/u.test(dayOfWeek)) return `every ${WEEKDAY_NAMES[Number(dayOfWeek) % 7]} at ${time}`;
  return null;
}
