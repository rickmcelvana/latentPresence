import { dayPart, type DayPart } from '../idle/catalogue';

/**
 * Time the way people say it (P6-T02, ADR-51): by calendar days and parts of the day in the
 * person's own clock, never a count of hours. "Yesterday evening" is a calendar fact — a talk at
 * 23:00 is yesterday at 08:00, nine hours later — which elapsed 24-hour blocks get wrong.
 *
 * Decided here, once, and tested, so a model is handed words to use rather than a number of
 * hours to turn into words (they then say "it has been 167 hours").
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];

/** 0..59 in words, the way the prompt asks her to say numbers. */
export function numberWord(n: number): string {
  if (n < 20) return ONES[n] ?? String(n);
  const tens = TENS[Math.floor(n / 10)];
  if (tens === undefined) return String(n);
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10]}`;
}

/** Whole calendar days from `then` to `now` in the local clock; DST-safe. */
export function calendarDays(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / DAY_MS);
}

/** "in the morning", "at night": how `RIGHT NOW` says the part of the day. */
export function partOfDayWords(now: Date): string {
  const part = dayPart(now.getHours());
  return part === 'night' ? 'at night' : `in the ${part}`;
}

/** "Thursday evening", "Friday night", "Monday morning". */
function dayAndPart(then: Date): string {
  return `${DAYS[then.getDay()]} ${dayPart(then.getHours())}`;
}

function plural(n: number, unit: string): string {
  return n === 1 ? `a ${unit}` : `${numberWord(n)} ${unit}s`;
}

/** Within the hour: "a few minutes", "about twenty minutes", "about half an hour". */
function minutesAgo(minutes: number): string {
  if (minutes < 2) return 'just now';
  if (minutes < 10) return 'a few minutes ago';
  if (minutes < 25) return `about ${numberWord(Math.round(minutes / 5) * 5)} minutes ago`;
  if (minutes < 40) return 'about half an hour ago';
  return 'about an hour ago';
}

/** The same calendar day, an hour and a half or more back. */
function sameDay(then: Date, now: Date): string {
  const was: DayPart = dayPart(then.getHours());
  const is: DayPart = dayPart(now.getHours());
  // 00:00–04:59 is the night *before* this day's morning.
  if (was === 'night' && then.getHours() < 5) return is === 'night' && now.getHours() < 5 ? 'earlier tonight' : 'last night';
  if (was === 'night') return 'earlier tonight';
  if (was === is) return `earlier this ${was}`;
  return `this ${was}`;
}

/** The calendar day before. */
function yesterday(then: Date): string {
  const was = dayPart(then.getHours());
  if (was === 'night') return then.getHours() >= 22 ? 'last night' : 'the night before last';
  return `yesterday ${was}`;
}

/**
 * When `then` was, from `now`: "about twenty minutes ago", "earlier this afternoon", "last
 * night", "yesterday evening", "on Thursday evening, four days ago", "a week ago, on Monday
 * evening", "nine days ago", "two weeks ago", "about a month ago", "about three months ago, in
 * July", "over a year ago".
 */
export function sinceWords(then: Date, now: Date): string {
  const elapsed = now.getTime() - then.getTime();
  if (elapsed < 90 * MINUTE_MS) return minutesAgo(Math.max(0, elapsed) / MINUTE_MS);
  const days = calendarDays(then, now);
  if (days <= 0) return sameDay(then, now);
  if (days === 1) return yesterday(then);
  if (days < 7) return `on ${dayAndPart(then)}, ${numberWord(days)} days ago`;
  if (days === 7) return `a week ago, on ${dayAndPart(then)}`;
  if (days < 14) return `${numberWord(days)} days ago`;
  if (days < 25) return `${plural(Math.round(days / 7), 'week')} ago`;
  if (days < 46) return 'about a month ago';
  if (days < 330) return `about ${numberWord(Math.round(days / 30.44))} months ago, in ${MONTHS[then.getMonth()]}`;
  const years = Math.round(days / 365.25);
  return years <= 1 ? 'over a year ago' : `about ${numberWord(years)} years ago`;
}

/**
 * How late a follow-up is (ADR-51): null until a calendar day has gone by since it was due, then
 * "it was for Friday, three days ago" — a week away reads as a week late, not as on time.
 * `on` is the follow-up's own `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.
 */
export function lateWords(on: string, now: Date): string | null {
  const [year, month, day] = on.slice(0, 10).split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const due = new Date(year, month - 1, day);
  const days = calendarDays(due, now);
  if (days < 1) return null;
  if (days === 1) return 'it was for yesterday';
  const which = days < 7 ? DAYS[due.getDay()] : `${day} ${MONTHS[month - 1]}`;
  const ago = days < 14 ? `${numberWord(days)} days ago` : `${plural(Math.round(days / 7), 'week')} ago`;
  return `it was for ${which}, ${ago}`;
}
