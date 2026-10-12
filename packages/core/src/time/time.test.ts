import alice from '../../../../personas/alice.persona.json' with { type: 'json' };
import { PersonaSchema, type MemoryEpisode } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from '../memory/fake-store';
import { renderSystemPrompt } from '../persona/prompt';
import { LAST_TURNS, OPENING_AFTER_MS, lastConversation, shouldOpen } from './last';
import { calendarDays, lateWords, numberWord, partOfDayWords, sinceWords } from './words';

const persona = PersonaSchema.parse(alice);

/** Local clock throughout: the words are the person's calendar days, so CI's UTC must not move them. */
const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 9, day, hour, minute);
/** Monday 12 October 2026, 8:30. */
const MONDAY_MORNING = at(12, 8, 30);

describe('sinceWords (P6-T02, ADR-51)', () => {
  it.each([
    [at(12, 8, 29), 'just now'],
    [at(12, 8, 25), 'a few minutes ago'],
    [at(12, 8, 10), 'about twenty minutes ago'],
    [at(12, 8, 0), 'about half an hour ago'],
    [at(12, 7, 30), 'about an hour ago'],
    [at(12, 6, 0), 'earlier this morning'],
    [at(12, 2, 0), 'last night'],
    [at(11, 23, 0), 'last night'],
    [at(11, 19, 40), 'yesterday evening'],
    [at(11, 14, 0), 'yesterday afternoon'],
    [at(11, 3, 0), 'the night before last'],
    [at(8, 19, 0), 'on Thursday evening, four days ago'],
    [at(10, 9, 0), 'on Saturday morning, two days ago'],
    [at(5, 19, 40), 'a week ago, on Monday evening'],
    [at(3, 12, 0), 'nine days ago'],
    [new Date(2026, 8, 28, 12), 'two weeks ago'],
    [new Date(2026, 8, 14, 12), 'about a month ago'],
    [new Date(2026, 6, 20, 12), 'about three months ago, in July'],
    [new Date(2025, 8, 1, 12), 'over a year ago'],
    [new Date(2023, 9, 1, 12), 'about three years ago'],
  ])('%s → %s', (then, words) => {
    expect(sinceWords(then, MONDAY_MORNING)).toBe(words);
  });

  it('counts calendar days, not 24-hour blocks: nine hours across midnight is yesterday', () => {
    expect(calendarDays(at(11, 23, 30), MONDAY_MORNING)).toBe(1);
    expect(sinceWords(at(11, 22, 30), at(12, 7, 30))).toBe('last night');
  });

  it('says the same afternoon as "this" and the same part as "earlier this"', () => {
    expect(sinceWords(at(12, 9, 0), at(12, 15, 0))).toBe('this morning');
    expect(sinceWords(at(12, 13, 0), at(12, 16, 0))).toBe('earlier this afternoon');
    expect(sinceWords(at(12, 17, 30), at(12, 21, 30))).toBe('earlier this evening');
  });

  it('never says a number of hours, and writes numbers as words', () => {
    for (let hours = 0; hours < 24 * 400; hours += 7) {
      expect(sinceWords(new Date(MONDAY_MORNING.getTime() - hours * 3_600_000), MONDAY_MORNING)).not.toMatch(/hour(s)? ago|\d/u);
    }
    expect(numberWord(21)).toBe('twenty-one');
    expect(numberWord(40)).toBe('forty');
  });

  it('names the part of the day for RIGHT NOW', () => {
    expect(partOfDayWords(MONDAY_MORNING)).toBe('in the morning');
    expect(partOfDayWords(at(12, 14))).toBe('in the afternoon');
    expect(partOfDayWords(at(12, 19))).toBe('in the evening');
    expect(partOfDayWords(at(12, 23))).toBe('at night');
  });
});

describe('lateWords', () => {
  it('is nothing on the day, then says the day it was for and how long ago', () => {
    expect(lateWords('2026-10-12', MONDAY_MORNING)).toBeNull();
    expect(lateWords('2026-10-12 07:00', MONDAY_MORNING)).toBeNull();
    expect(lateWords('2026-10-11', MONDAY_MORNING)).toBe('it was for yesterday');
    expect(lateWords('2026-10-09', MONDAY_MORNING)).toBe('it was for Friday, three days ago');
    expect(lateWords('2026-10-02', MONDAY_MORNING)).toBe('it was for 2 October, ten days ago');
    expect(lateWords('2026-09-21', MONDAY_MORNING)).toBe('it was for 21 September, three weeks ago');
  });
});

let turn = 0;
function said(sessionId: string, role: 'user' | 'assistant', text: string, when: Date): MemoryEpisode {
  turn += 1;
  return { id: `e${turn}`, sessionId, characterId: 'alice', role, text, interrupted: false, at: when.toISOString(), embedding: null, affect: null };
}

/** Rick plans a trip on Monday evening and promises the dates by Friday. */
async function aWeekAgo(): Promise<FakeMemoryStore> {
  const store = new FakeMemoryStore();
  const turns: [string, 'user' | 'assistant', string, Date][] = [
    ['visit-1', 'user', 'Can we plan the trip to Norway?', at(5, 19, 30)],
    ['visit-1', 'assistant', 'Yes! Fjords or cities first?', at(5, 19, 31)],
    ['visit-1', 'user', 'Fjords. I need to sort out the dates with work first.', at(5, 19, 35)],
    ['visit-1', 'assistant', 'Fjords it is. When will you know the dates?', at(5, 19, 36)],
    ['visit-1', 'user', "I'll know the travel dates by Friday.", at(5, 19, 40)],
    ['visit-1', 'assistant', "Sounds great — I'll check in on Friday.", at(5, 19, 41)],
    ['visit-1', 'user', 'Night!', at(5, 19, 42)],
  ];
  for (const [sessionId, role, text, when] of turns) await store.appendEpisode(said(sessionId, role, text, when));
  return store;
}

describe('lastConversation', () => {
  it('is null when they have never talked, or when she only ever spoke', async () => {
    const store = new FakeMemoryStore();
    expect(await lastConversation(store, 'alice', 'now')).toBeNull();
    await store.appendEpisode(said('old', 'assistant', 'Good morning!', at(11, 9)));
    expect(await lastConversation(store, 'alice', 'now')).toBeNull();
  });

  it('is the newest earlier session with a turn of theirs, its last turns oldest first', async () => {
    const store = await aWeekAgo();
    // A later visit where she opened and they never answered is not the last conversation.
    await store.appendEpisode(said('visit-x', 'assistant', 'Hello again!', at(8, 12)));
    const last = await lastConversation(store, 'alice', 'visit-2');
    expect(last?.at).toBe(at(5, 19, 42).toISOString());
    expect(last?.turns).toHaveLength(LAST_TURNS);
    expect(last?.turns.at(0)?.text).toBe('Yes! Fjords or cities first?');
    expect(last?.turns.at(-1)).toEqual({ role: 'user', text: 'Night!' });
  });

  it('leaves out the visit asking, and cuts a long turn', async () => {
    const store = await aWeekAgo();
    await store.appendEpisode(said('visit-2', 'user', 'this visit', at(12, 8)));
    await store.appendEpisode(said('visit-0', 'user', 'x'.repeat(400), at(1, 10)));
    expect((await lastConversation(store, 'alice', 'visit-2'))?.turns.at(-1)?.text).toBe('Night!');
    const old = await lastConversation(new FakeMemoryStore(), 'alice', 'a');
    expect(old).toBeNull();
    const long = new FakeMemoryStore();
    await long.appendEpisode(said('v', 'user', 'x'.repeat(400), at(1, 10)));
    expect((await lastConversation(long, 'alice', 'w'))?.turns[0]?.text).toMatch(/^x{279}…$/u);
  });
});

describe('shouldOpen', () => {
  it('opens after an hour away, never within it, never on a first meeting', () => {
    const last = { at: at(12, 7, 0).toISOString(), turns: [] };
    expect(shouldOpen(null, MONDAY_MORNING)).toBe(false);
    expect(shouldOpen(last, new Date(at(12, 7, 0).getTime() + OPENING_AFTER_MS - 1))).toBe(false);
    expect(shouldOpen(last, new Date(at(12, 7, 0).getTime() + OPENING_AFTER_MS))).toBe(true);
  });
});

describe('reopening after a simulated week (the done-when)', () => {
  it('greets the morning, says it has been a week since Monday evening, how it ended, and that Friday is late', async () => {
    const store = await aWeekAgo();
    const since = await lastConversation(store, 'alice', 'visit-2');
    expect(shouldOpen(since, MONDAY_MORNING)).toBe(true);
    const prompt = renderSystemPrompt(persona, {
      now: MONDAY_MORNING,
      since,
      opening: true,
      plans: { plans: [], focusId: null, followUps: [{ plan: 'Norway trip', on: '2026-10-09', about: 'whether they have the travel dates' }] },
    });
    const section = (name: string, next: string): string => prompt.slice(prompt.indexOf(name), prompt.indexOf(next));

    expect(section('LAST TIME YOU TALKED', 'YOU SPEAK FIRST')).toMatchInlineSnapshot(`
      "LAST TIME YOU TALKED
      - You last talked with them a week ago, on Monday evening.
      - It ended like this:
        You said: "Yes! Fjords or cities first?"
        They said: "Fjords. I need to sort out the dates with work first."
        You said: "Fjords it is. When will you know the dates?"
        They said: "I'll know the travel dates by Friday."
        You said: "Sounds great — I'll check in on Friday."
        They said: "Night!"
      - Let the time that has passed show the way it would with a friend: after a few hours there
        is nothing to remark on; after days, it has been a while. Say it in everyday words, never
        as a number of hours.

      "
    `);
    expect(section('YOU SPEAK FIRST', 'RIGHT NOW')).toContain('- Greet them for the time of day it is for them: it is the morning.');
    expect(prompt).toContain('  Norway trip, on 9 October 2026: whether they have the travel dates (due now — it was for Friday, three days ago).');
    expect(prompt.endsWith('RIGHT NOW\n- It is Monday 12 October 2026, 8:30 in the morning.')).toBe(true);
    // Last time comes after the plans and before RIGHT NOW, which stays last.
    expect(prompt.indexOf('PLANNING TOGETHER')).toBeLessThan(prompt.indexOf('LAST TIME YOU TALKED'));
  });

  it('reads the same conversation as yesterday evening the next morning, and says nothing of opening once they speak', async () => {
    const since = await lastConversation(await aWeekAgo(), 'alice', 'visit-2');
    const tuesday = renderSystemPrompt(persona, { now: at(6, 8, 15), since });
    expect(tuesday).toContain('- You last talked with them yesterday evening.');
    expect(tuesday).not.toContain('YOU SPEAK FIRST');
    expect(renderSystemPrompt(persona, { now: at(6, 8, 15) })).not.toContain('LAST TIME YOU TALKED');
  });
});
