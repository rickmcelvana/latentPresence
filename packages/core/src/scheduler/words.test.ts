import { describe, expect, it } from 'vitest';
import { clockWords, dueWords, repeatWords, whenWords } from './words';

const CHICAGO = 'America/Chicago';
const at = (iso: string): Date => new Date(iso);

describe('whenWords (P6-T08)', () => {
  // Tuesday 2026-10-13 10:00 in Chicago (CDT, UTC-5).
  const now = at('2026-10-13T15:00:00Z');

  it('says today, tomorrow, a weekday and date, and the year only when it is not this one', () => {
    expect(whenWords(at('2026-10-14T02:00:00Z'), at('2026-10-13T23:00:00Z'), CHICAGO)).toBe('today at 21:00 (in 3 hours)');
    expect(whenWords(at('2026-10-14T14:00:00Z'), at('2026-10-14T00:00:00Z'), CHICAGO)).toBe('tomorrow at 09:00 (in 14 hours)');
    expect(whenWords(at('2026-10-14T14:00:00Z'), at('2026-10-13T20:00:00Z'), CHICAGO)).toBe('tomorrow at 09:00 (in 18 hours)');
    expect(whenWords(at('2026-10-15T14:00:00Z'), now, CHICAGO)).toBe('Thursday 15 October at 09:00 (in 1 day and 23 hours)');
    expect(whenWords(at('2027-01-03T14:00:00Z'), now, CHICAGO)).toBe('Sunday 3 January 2027 at 08:00 (in 81 days and 23 hours)');
  });

  it('measures the distance in minutes, then hours and minutes, then days and hours, dropping zeros', () => {
    expect(whenWords(at('2026-10-13T15:01:00Z'), now, CHICAGO)).toBe('today at 10:01 (in 1 minute)');
    expect(whenWords(at('2026-10-13T15:40:00Z'), now, CHICAGO)).toBe('today at 10:40 (in 40 minutes)');
    expect(whenWords(at('2026-10-13T17:05:00Z'), now, CHICAGO)).toBe('today at 12:05 (in 2 hours and 5 minutes)');
    expect(whenWords(at('2026-10-13T16:00:00Z'), now, CHICAGO)).toBe('today at 11:00 (in 1 hour)');
    expect(whenWords(at('2026-10-16T15:00:00Z'), now, CHICAGO)).toBe('Friday 16 October at 10:00 (in 3 days)');
    // Half a minute still reads as a minute, not "now"; a time that is not ahead is now.
    expect(whenWords(at('2026-10-13T15:00:30Z'), now, CHICAGO)).toBe('today at 10:00 (in 1 minute)');
    expect(whenWords(now, now, CHICAGO)).toBe('today at 10:00 (now)');
  });

  it('decides the day in the zone, not in UTC', () => {
    // 02:00Z on the 14th is still the evening of the 13th in Chicago.
    expect(whenWords(at('2026-10-14T02:00:00Z'), now, CHICAGO)).toBe('today at 21:00 (in 11 hours)');
    expect(whenWords(at('2026-10-14T02:00:00Z'), now, 'Pacific/Auckland')).toBe('today at 15:00 (in 11 hours)');
  });

  it('counts real time across a clock change: the day the clocks go back is 25 hours long', () => {
    // Chicago 2026-11-01: 00:00 CDT (05:00Z) to 08:00 CST (14:00Z) is nine hours, not eight.
    expect(whenWords(at('2026-11-01T14:00:00Z'), at('2026-11-01T05:00:00Z'), CHICAGO)).toBe('today at 08:00 (in 9 hours)');
    expect(whenWords(at('2026-11-02T15:00:00Z'), at('2026-10-31T15:00:00Z'), CHICAGO)).toBe('Monday 2 November at 09:00 (in 2 days)');
  });

  it('reads a half-hour zone: Chatham, +13:45 in October', () => {
    // 19:15Z on the 14th is 09:00 on the 15th in Chatham; its "now" is 13:45 on the 14th.
    expect(whenWords(at('2026-10-14T19:15:00Z'), at('2026-10-14T00:00:00Z'), 'Pacific/Chatham')).toBe('tomorrow at 09:00 (in 19 hours and 15 minutes)');
  });
});

describe('dueWords and clockWords (P6-T08)', () => {
  const now = at('2026-10-15T14:30:00Z');
  it('puts a time that has passed in the past tense', () => {
    expect(dueWords(at('2026-10-15T14:00:00Z'), now, CHICAGO)).toBe('at 09:00 this morning');
    expect(dueWords(at('2026-10-15T09:00:00Z'), now, CHICAGO)).toBe('at 04:00 this morning');
    expect(dueWords(at('2026-10-14T23:30:00Z'), now, CHICAGO)).toBe('at 18:30 yesterday');
    expect(dueWords(at('2026-10-12T14:00:00Z'), now, CHICAGO)).toBe('on Monday 12 October at 09:00');
    expect(dueWords(at('2026-10-15T14:20:00Z'), at('2026-10-15T23:30:00Z'), CHICAGO)).toBe('at 09:20 this morning');
    expect(dueWords(at('2026-10-15T19:20:00Z'), at('2026-10-15T23:30:00Z'), CHICAGO)).toBe('at 14:20 this afternoon');
  });
  it('says what time it is without a distance', () => {
    expect(clockWords(now, now, CHICAGO)).toBe('Thursday 15 October at 09:30');
  });
});

describe('repeatWords (P6-T08)', () => {
  it('names the common shapes', () => {
    expect(repeatWords('0 9 * * *')).toBe('every day at 09:00');
    expect(repeatWords('30 7 * * 1-5')).toBe('weekdays at 07:30');
    expect(repeatWords('0 18 * * 0')).toBe('every Sunday at 18:00');
    expect(repeatWords('0 18 * * 7')).toBe('every Sunday at 18:00');
    expect(repeatWords('15 8 * * 3')).toBe('every Wednesday at 08:15');
    expect(repeatWords('*/15 * * * *')).toBe('every 15 minutes');
    expect(repeatWords('*/1 * * * *')).toBe('every minute');
  });
  it('is null for anything else, so the caller shows the expression', () => {
    expect(repeatWords('0 9 1 * *')).toBeNull();
    expect(repeatWords('0 9,17 * * *')).toBeNull();
    expect(repeatWords('0 9 * * 1,3')).toBeNull();
    expect(repeatWords('*/15 9 * * *')).toBeNull();
    expect(repeatWords('*/0 * * * *')).toBeNull();
    expect(repeatWords('0 25 * * *')).toBeNull();
    expect(repeatWords('0 0 9 * * *')).toBeNull();
    expect(repeatWords('')).toBeNull();
  });
});
