import type { ConversationEvent, PlanDocument, SemanticFact } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { ConversationMachine } from '../conversation/machine';
import { attachInitiative, type InitiativeChat } from './attach';
import {
  INITIATIVE_BUDGETS,
  decideInitiative,
  dueFollowUps,
  parseLedger,
  quietWords,
  serializeLedger,
  thoughtTopics,
  withinBudget,
  type InitiativeEntry,
  type InitiativeSituation,
} from './initiative';
import { simulateInitiativeDay } from './simulate';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Monday 12 October 2026, 14:00, local. */
const AFTERNOON = new Date(2026, 9, 12, 14, 0);
const NOW = AFTERNOON.getTime();

const FOLLOW = { key: 'follow:Norway trip:2026-10-12', plan: 'Norway trip', about: 'whether they have the dates', timed: false };
const THOUGHT = { key: 'plan:p1:Dig in compost', about: 'the plan you are making with them, "Garden" (their next step: Dig in compost)' };

function situation(over: Partial<InitiativeSituation> = {}): InitiativeSituation {
  return { now: AFTERNOON, dial: 'normal', ledger: [], quietMs: 30 * MINUTE, blocked: false, unanswered: false, followUps: [FOLLOW], thoughts: [THOUGHT], ...over };
}

function fact(id: string, predicate: string, object: string, day: number): SemanticFact {
  return { id, characterId: 'alice', subject: 'user', predicate, object, confidence: 0.9, validFrom: `2026-10-0${day}T00:00:00.000Z`, validTo: null, recordedAt: `2026-10-0${day}T00:00:00.000Z`, sourceEpisodeId: null, embedding: null };
}

const spoke = (agoMs: number, kind: InitiativeEntry['kind'] = 'follow-up', key: string | null = null): InitiativeEntry => ({ at: NOW - agoMs, kind, key, answered: true });

describe('decideInitiative (P6-T03, ADR-52)', () => {
  it('raises a due follow-up first, with a cue that names it', () => {
    const decision = decideInitiative(situation());
    expect(decision?.kind).toBe('follow-up');
    expect(decision?.cue).toContain('Norway trip — whether they have the dates');
    expect(decision?.cue).toContain('about half an hour');
  });

  it('says nothing when off, blocked, or still waiting for an answer', () => {
    expect(decideInitiative(situation({ dial: 'off' }))).toBeNull();
    expect(decideInitiative(situation({ blocked: true }))).toBeNull();
    expect(decideInitiative(situation({ unanswered: true }))).toBeNull();
  });

  it('keeps to the budget over a rolling 24 hours, the opener included', () => {
    const six = [1, 2, 3, 4, 5, 6].map((hours) => spoke(hours * HOUR, hours === 6 ? 'opener' : 'thought', `k${hours}`));
    expect(decideInitiative(situation({ ledger: six }))).toBeNull();
    // The oldest falls out of the window a day later.
    expect(decideInitiative(situation({ ledger: [...six.slice(0, 5), spoke(24 * HOUR + 1, 'opener')] }))?.kind).toBe('follow-up');
    expect(withinBudget('rare', [spoke(HOUR), spoke(2 * HOUR)], NOW)).toBe(false);
    expect(withinBudget('off', [], NOW)).toBe(false);
  });

  it('leaves a gap between check-ins, but not after an opener', () => {
    expect(decideInitiative(situation({ ledger: [spoke(30 * MINUTE, 'thought', 'x')] }))).toBeNull();
    expect(decideInitiative(situation({ ledger: [spoke(46 * MINUTE, 'thought', 'x')] }))?.kind).toBe('follow-up');
    expect(decideInitiative(situation({ ledger: [spoke(MINUTE, 'opener')] }))?.kind).toBe('follow-up');
    expect(decideInitiative(situation({ dial: 'rare', ledger: [spoke(2 * HOUR, 'follow-up', 'x')] }))).toBeNull();
  });

  it('waits for quiet: two minutes for a follow-up at normal, five at rare, twenty for a thought', () => {
    expect(decideInitiative(situation({ quietMs: MINUTE }))).toBeNull();
    expect(decideInitiative(situation({ quietMs: 3 * MINUTE }))?.kind).toBe('follow-up');
    expect(decideInitiative(situation({ dial: 'rare', quietMs: 3 * MINUTE }))).toBeNull();
    expect(decideInitiative(situation({ followUps: [], quietMs: 10 * MINUTE }))).toBeNull();
    expect(decideInitiative(situation({ followUps: [], quietMs: 21 * MINUTE }))?.kind).toBe('thought');
  });

  it('does not raise the same thing twice in a day, nor more than two thoughts', () => {
    expect(decideInitiative(situation({ ledger: [spoke(2 * HOUR, 'follow-up', FOLLOW.key)] }))?.kind).toBe('thought');
    const twoThoughts = [spoke(2 * HOUR, 'thought', 'a'), spoke(3 * HOUR, 'thought', 'b')];
    expect(decideInitiative(situation({ followUps: [], ledger: twoThoughts }))).toBeNull();
  });

  it('has no thoughts at rare or at night; at night only a follow-up they set for a time', () => {
    expect(decideInitiative(situation({ dial: 'rare', followUps: [] }))).toBeNull();
    const night = new Date(2026, 9, 12, 23, 30);
    expect(decideInitiative(situation({ now: night }))).toBeNull();
    expect(decideInitiative(situation({ now: night, followUps: [{ ...FOLLOW, timed: true }] }))?.kind).toBe('follow-up');
  });
});

describe('the pieces it reads', () => {
  it('finds due follow-ups by the plans section own test, timed or not', () => {
    const due = dueFollowUps(
      [
        { plan: 'a', on: '2026-10-12', about: 'x' },
        { plan: 'b', on: '2026-10-12 13:30', about: 'y' },
        { plan: 'c', on: '2026-10-12 15:00', about: 'z' },
        { plan: 'd', on: '2026-10-13', about: 'w' },
      ],
      AFTERNOON,
    );
    expect(due.map((follow) => [follow.plan, follow.timed])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('offers an active plan\'s next open step, then what she knows, newest first; no follow-up facts', () => {
    const plan = { id: 'p1', characterId: 'alice', title: 'Garden', goal: '', status: 'active', version: 1, updatedAt: '2026-10-01T00:00:00.000Z', phases: [{ id: 'ph', title: 'Prep', tasks: [{ id: 't1', title: 'Clear the bed', status: 'done', notes: '' }, { id: 't2', title: 'Dig in compost', status: 'todo', notes: '' }] }] } satisfies PlanDocument;
    const topics = thoughtTopics([plan, { ...plan, id: 'p2', status: 'done' }], [fact('f1', 'likes', 'jazz', 1), fact('f2', 'follow_up_on', '2026-10-12: x', 3), fact('f3', 'likes', 'Thai food', 2)]);
    expect(topics.map((topic) => topic.key)).toEqual(['plan:p1:Dig in compost', 'fact:f3', 'fact:f1']);
    expect(topics[1]?.about).toContain('user likes Thai food');
  });

  it('keeps the ledger to 24 hours, and reads anything unreadable as none', () => {
    const text = serializeLedger([spoke(HOUR), spoke(25 * HOUR), { ...spoke(2 * HOUR), answered: false }], NOW);
    expect(parseLedger(text, NOW).map((entry) => entry.answered)).toEqual([true, false]);
    expect(parseLedger('{"spoke":[{"at":"x"},{"at":1,"kind":"gossip"}]}', NOW)).toEqual([]);
    expect(parseLedger('not json', NOW)).toEqual([]);
    expect(parseLedger(null, NOW)).toEqual([]);
  });

  it('says the quiet in words', () => {
    expect(quietWords(3 * MINUTE)).toBe('a few minutes');
    expect(quietWords(21 * MINUTE)).toBe('about twenty minutes');
    expect(quietWords(2 * HOUR)).toBe('a while');
  });
});

function rig(options: { ledger?: string | null; dial?: 'off' | 'rare' | 'normal' } = {}) {
  let clock = NOW;
  const machine = new ConversationMachine({ sessionId: 's', characterId: 'alice', now: () => new Date(clock).toISOString() });
  machine.start();
  const said: string[] = [];
  const chat: InitiativeChat = {
    open: () => (said.push('opener'), true),
    speakUp: (cue) => (said.push(cue), true),
  };
  const store = { text: options.ledger ?? null };
  let typing = false;
  const build = () =>
    attachInitiative(machine, {
      chat,
      dial: () => options.dial ?? 'normal',
      blocked: () => typing,
      followUps: () => [{ plan: 'Norway trip', on: '2026-10-12', about: 'the dates' }],
      plans: () => [],
      facts: () => [],
      ledger: {
        read: () => store.text,
        write: async (text) => {
          store.text = text;
        },
      },
      now: () => clock,
    });
  const dispatch = (event: Record<string, unknown>): void => machine.dispatch({ ...event, sessionId: 's', at: new Date(clock).toISOString() } as unknown as ConversationEvent);
  return {
    machine,
    said,
    store,
    build,
    dispatch,
    advance: (ms: number) => (clock += ms),
    setTyping: (value: boolean) => (typing = value),
  };
}

describe('attachInitiative', () => {
  it('speaks up after the quiet, and not while they type or speak', () => {
    const r = rig();
    const initiative = r.build();
    r.advance(MINUTE);
    expect(initiative.tick()).toBeNull();
    r.advance(2 * MINUTE);
    r.setTyping(true);
    expect(initiative.tick()).toBeNull();
    r.setTyping(false);
    r.dispatch({ type: 'user.speech.started' });
    r.advance(3 * MINUTE);
    expect(initiative.tick()).toBeNull();
    r.dispatch({ type: 'user.turn.ended', probability: 0.9 });
    r.dispatch({ type: 'user.message', text: 'hi' });
    r.dispatch({ type: 'assistant.message', entry: { id: 'a', role: 'assistant', text: 'Hey.', at: new Date().toISOString(), spokenPrefix: null } });
    r.advance(3 * MINUTE);
    expect(initiative.tick()?.kind).toBe('follow-up');
    expect(r.said[0]).toContain('Norway trip — the dates');
  });

  it('remembers across a reload what it spent and that it is still waiting for an answer', () => {
    const r = rig();
    const first = r.build();
    r.advance(5 * MINUTE);
    expect(first.tick()).not.toBeNull();
    first.detach();
    // Reloaded: the ledger comes back from the block.
    const second = r.build();
    r.advance(HOUR);
    expect(second.entries()).toHaveLength(1);
    expect(second.tick()).toBeNull();
    r.dispatch({ type: 'user.message', text: 'yes, got them' });
    expect(parseLedger(r.store.text, NOW + 2 * HOUR)[0]?.answered).toBe(true);
  });

  it('opens when they come back, not when the dial is off, the budget is spent, or within the hour', () => {
    const since = { at: new Date(NOW - 2 * HOUR).toISOString(), turns: [] };
    expect(rig().build().open(since)).toBe(true);
    expect(rig({ dial: 'off' }).build().open(since)).toBe(false);
    expect(rig().build().open({ at: new Date(NOW - 10 * MINUTE).toISOString(), turns: [] })).toBe(false);
    const spent = serializeLedger([spoke(HOUR), spoke(2 * HOUR)], NOW);
    expect(rig({ dial: 'rare', ledger: spent }).build().open(since)).toBe(false);
    // The opener picks up the due follow-up, so it is marked raised.
    const r = rig();
    const initiative = r.build();
    initiative.open(since);
    expect(initiative.entries()[0]).toMatchObject({ kind: 'opener', key: 'follow:Norway trip:2026-10-12' });
  });

  it('does not open again on a reload within the hour of an opener they have not answered', () => {
    const since = { at: new Date(NOW - 2 * HOUR).toISOString(), turns: [] };
    const r = rig();
    const first = r.build();
    expect(first.open(since)).toBe(true);
    first.detach();
    // Reloaded three minutes later: their last conversation is still two hours old.
    r.advance(3 * MINUTE);
    expect(r.build().open(since)).toBe(false);
    // Gone an hour and more, it is a return again.
    r.advance(HOUR);
    expect(r.build().open(since)).toBe(true);
  });
});

describe('a simulated day (the done-when)', () => {
  const SEEDS = Array.from({ length: 30 }, (_, index) => index + 1);

  it.each(['off', 'rare', 'normal'] as const)('never exceeds the budget at %s: 30 days, every rule checked as it happens', (dial) => {
    for (const seed of SEEDS) {
      const day = simulateInitiativeDay({ seed, dial });
      expect(day.violations, `seed ${seed}`).toEqual([]);
      expect(day.visits).toBeGreaterThanOrEqual(3);
      if (dial === 'off') expect(day.spoke).toEqual([]);
      else expect(day.spoke.length).toBeLessThanOrEqual(INITIATIVE_BUDGETS[dial].perDay);
    }
  });

  it('does speak up at normal: follow-ups raised every day, thoughts no more than two', () => {
    for (const seed of SEEDS) {
      const day = simulateInitiativeDay({ seed, dial: 'normal' });
      expect(day.spoke.some((entry) => entry.kind === 'follow-up'), `seed ${seed}`).toBe(true);
      expect(day.spoke.filter((entry) => entry.kind === 'thought').length).toBeLessThanOrEqual(2);
    }
  });

  it('holds the rolling window over three days, through midnights and reloads', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      for (const dial of ['rare', 'normal'] as const) expect(simulateInitiativeDay({ seed, dial, hours: 72 }).violations, `${dial} ${seed}`).toEqual([]);
    }
  });
});
