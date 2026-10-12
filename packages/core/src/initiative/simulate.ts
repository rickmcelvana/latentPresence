import type { ConversationEvent, PlanDocument, SemanticFact } from '@latentpresence/protocol';
import { ConversationMachine, type Scheduler } from '../conversation/machine';
import { dayPart } from '../idle/catalogue';
import { seededRandom } from '../idle/planner';
import type { PromptPlans } from '../plan/plans';
import { attachInitiative, type AttachedInitiative } from './attach';
import { INITIATIVE_BUDGETS, INITIATIVE_WINDOW_MS, type InitiativeDial, type InitiativeKind } from './initiative';

/**
 * A simulated day with her page open (P6-T03, ADR-52): the done-when's "24 h simulated run".
 *
 * It drives the **real** `attachInitiative` on a real `ConversationMachine`, on a simulated clock,
 * against a modelled person: awake from about half past seven to eleven, the tab left open
 * overnight (the worst case for a budget), reloaded a few times a day (the ledger must survive
 * it), talking in bursts — typed, with time spent typing, or by voice — and answering her about
 * half the time. Follow-ups come due through the day, one at a set time that may be at night.
 *
 * Every turn she starts is checked, at that moment, against the person's own state — not against
 * what the attachment was told — and the whole run against the budget over every rolling 24 h.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export interface InitiativeDayOptions {
  readonly seed: number;
  readonly dial: InitiativeDial;
  /** 24 by default; longer runs cross midnight more than once. */
  readonly hours?: number;
  /** 06:00 on Monday 12 October 2026, local, by default. */
  readonly start?: Date;
}

export interface InitiativeDaySpoke {
  readonly at: number;
  readonly kind: InitiativeKind;
  readonly key: string | null;
  readonly answered: boolean;
}

export interface InitiativeDayResult {
  readonly start: Date;
  readonly spoke: readonly InitiativeDaySpoke[];
  /** Every rule broken, with when; empty is the pass. */
  readonly violations: readonly string[];
  readonly visits: number;
  readonly userTurns: number;
  readonly followUps: number;
}

/** A clock and a timer queue: nothing happens until `runUntil`. */
class SimClock implements Scheduler {
  now = 0;
  private seq = 0;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.queue.set(this.seq, { at: this.now + Math.max(0, ms), fn });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.queue.delete(handle as number);
  }

  at(time: number, fn: () => void): void {
    this.setTimeout(fn, time - this.now);
  }

  runUntil(end: number): void {
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.queue) if (next === null || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[0] < next[0])) next = entry;
      if (next === null || next[1].at > end) break;
      this.queue.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

const PLAN: PlanDocument = {
  id: 'plan-garden',
  characterId: 'alice',
  title: 'Vegetable garden',
  goal: 'Easy vegetables by spring.',
  status: 'active',
  version: 1,
  phases: [
    {
      id: 'phase-prepare',
      title: 'Prepare',
      tasks: [
        { id: 'task-compost', title: 'Dig in compost', status: 'todo', notes: '' },
        { id: 'task-seedlings', title: 'Buy seedlings', status: 'todo', notes: '' },
      ],
    },
  ],
  updatedAt: '2026-10-01T10:00:00.000Z',
};

function fact(id: string, object: string, day: number): SemanticFact {
  const at = `2026-10-0${day}T00:00:00.000Z`;
  return { id, characterId: 'alice', subject: 'user', predicate: 'likes', object, confidence: 0.8, validFrom: at, validTo: null, recordedAt: at, sourceEpisodeId: null, embedding: null };
}

const FACTS: readonly SemanticFact[] = [fact('f1', 'Thai food', 1), fact('f2', 'jazz', 2), fact('f3', 'long walks', 3)];

/** Up from half past seven to eleven. */
function awake(time: number): boolean {
  const hours = new Date(time).getHours() + new Date(time).getMinutes() / 60;
  return hours >= 7.5 && hours < 23;
}

export function simulateInitiativeDay(options: InitiativeDayOptions): InitiativeDayResult {
  const start = options.start ?? new Date(2026, 9, 12, 6, 0);
  const t0 = start.getTime();
  const end = t0 + (options.hours ?? 24) * HOUR_MS;
  const random = seededRandom(options.seed);
  const between = (low: number, high: number): number => low + random() * (high - low);
  const clock = new SimClock();
  clock.now = t0;
  const iso = (): string => new Date(clock.now).toISOString();

  const machine = new ConversationMachine({ sessionId: 'sim', characterId: 'alice', now: iso });
  machine.start();
  const dispatch = (event: Record<string, unknown>): void => machine.dispatch({ ...event, sessionId: 'sim', at: iso() } as unknown as ConversationEvent);

  // The person, as the simulation knows them — what every turn she starts is checked against.
  const person = { typing: false, speaking: false, voiceOpen: false, inBurst: false };
  let herBusy = false;
  let lastUserAt: number | null = null;
  let userTurns = 0;
  let visits = 0;
  let ledgerText: string | null = null;
  const followUps: PromptPlans['followUps'][number][] = [];
  const spoke: { at: number; kind: InitiativeKind; key: string | null; answered: boolean }[] = [];
  const violations: string[] = [];
  const when = (): string => new Date(clock.now).toTimeString().slice(0, 5);

  // Her answer: a few seconds of thinking, then settled.
  const herAnswer = (): void => {
    herBusy = true;
    clock.setTimeout(() => {
      dispatch({ type: 'assistant.message', entry: { id: `a${clock.now}`, role: 'assistant', text: 'Mm.', at: iso(), spokenPrefix: null } });
      herBusy = false;
    }, between(3, 8) * SECOND_MS);
  };

  const userSays = (voice: boolean): void => {
    if (voice) {
      person.speaking = true;
      dispatch({ type: 'user.speech.started' });
      clock.setTimeout(() => {
        person.speaking = false;
        dispatch({ type: 'user.speech.ended' });
        dispatch({ type: 'user.turn.ended', probability: 0.9 });
        dispatch({ type: 'user.message', text: 'said' });
        userTurns += 1;
        lastUserAt = clock.now;
        herAnswer();
      }, between(3, 15) * SECOND_MS);
      return;
    }
    person.typing = true;
    clock.setTimeout(() => {
      person.typing = false;
      dispatch({ type: 'user.message', text: 'typed' });
      userTurns += 1;
      lastUserAt = clock.now;
      herAnswer();
    }, between(5, 30) * SECOND_MS);
  };

  /** A run of exchanges; `then` once it is over. */
  const burst = (exchanges: number, voice: boolean, then: () => void): void => {
    person.inBurst = true;
    if (voice) person.voiceOpen = true;
    let left = exchanges;
    const next = (): void => {
      if (left === 0) {
        person.inBurst = false;
        person.voiceOpen = false;
        then();
        return;
      }
      left -= 1;
      userSays(voice);
      clock.setTimeout(next, between(40, 150) * SECOND_MS);
    };
    next();
  };

  // Every turn she starts is checked here, against the person, at that moment.
  const checked = (kind: 'opener' | 'check-in', begin: () => void): boolean => {
    if (herBusy) return false;
    const wrong = [
      ...(options.dial === 'off' ? ['the dial is off'] : []),
      ...(person.typing ? ['they were typing'] : []),
      ...(person.speaking ? ['they were speaking'] : []),
      ...(person.voiceOpen ? ['a voice call was open'] : []),
      ...(machine.getState() !== 'listening' && machine.getState() !== 'idle' ? [`she was ${machine.getState()}`] : []),
      // The opener is exempt: coming back to the page is their answer (ADR-52).
      ...(kind === 'check-in' && spoke.length > 0 && !spoke.at(-1)!.answered ? ['her last one had no answer'] : []),
    ];
    for (const rule of wrong) violations.push(`${when()} ${kind}: ${rule}`);
    begin();
    herAnswer();
    return true;
  };

  const chat = {
    open: () => checked('opener', () => dispatch({ type: 'assistant.opening' })),
    speakUp: (cue: string) => (cue === '' ? false : checked('check-in', () => dispatch({ type: 'assistant.opening' }))),
  };

  // A holder, not a `let`: it is set inside the clock's callbacks.
  const current: { initiative: AttachedInitiative | null } = { initiative: null };
  const visit = (): void => {
    current.initiative?.detach();
    visits += 1;
    const initiative = attachInitiative(machine, {
      chat,
      dial: () => options.dial,
      blocked: () => person.typing || person.voiceOpen,
      followUps: () => followUps,
      plans: () => [PLAN],
      facts: () => FACTS,
      ledger: {
        read: () => ledgerText,
        write: async (text) => {
          ledgerText = text;
        },
      },
      scheduler: clock,
      now: () => clock.now,
    });
    current.initiative = initiative;
    initiative.open(lastUserAt === null ? null : { at: new Date(lastUserAt).toISOString(), turns: [] });
  };

  // Whatever the attachment recorded is what she started; mark the newest when they answer it.
  const unsubscribe = machine.subscribe((event) => {
    if (event.type === 'assistant.opening') {
      // The attachment records the turn once the chat has started it: read it right after.
      clock.setTimeout(() => {
        const recorded = current.initiative?.entries().at(-1);
        if (recorded !== undefined) spoke.push({ at: recorded.at, kind: recorded.kind, key: recorded.key, answered: false });
      }, 0);
    }
    if (event.type === 'user.message' && spoke.length > 0) {
      const last = spoke.at(-1)!;
      if (!last.answered) {
        spoke[spoke.length - 1] = { ...last, answered: true };
        // Answered: the follow-up she raised is done with, as she cancels it then.
        const raised = last.key;
        if (raised?.startsWith('follow:') === true) {
          const index = followUps.findIndex((follow) => `follow:${follow.plan}:${follow.on}` === raised);
          if (index >= 0) followUps.splice(index, 1);
        }
      }
    }
  });

  // The day, laid out in advance from the seed.
  for (let day = t0; day < end; day += 24 * HOUR_MS) {
    const date = new Date(day);
    const morning = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 7, 30).getTime() + between(0, 45) * MINUTE_MS;
    const reloads = [morning, ...Array.from({ length: 2 + Math.floor(random() * 3) }, () => morning + between(1, 14) * HOUR_MS)].toSorted((a, b) => a - b);
    for (const reload of reloads) if (reload < end) clock.at(reload, visit);
    // Follow-ups, one per plan (ADR-41): two for the day, one for a time (sometimes late at night).
    followUps.push({ plan: 'Vegetable garden', on: dayKey(date), about: 'how the soil is going' }, { plan: 'Norway trip', on: dayKey(date), about: 'whether they have the dates' });
    const timed = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(between(9, 24)) % 24, 0);
    followUps.push({ plan: 'Compost delivery', on: `${dayKey(timed)} ${two(timed.getHours())}:00`, about: 'whether it came' });
    // Bursts of talk while awake, and answers to her about half the time.
    let at = morning + between(5, 40) * MINUTE_MS;
    const dayEnd = Math.min(end, new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 0).getTime());
    while (at < dayEnd) {
      clock.at(at, () => {
        if (!person.inBurst) burst(2 + Math.floor(random() * 6), random() < 0.3, () => {});
      });
      at += between(30, 150) * MINUTE_MS;
    }
  }
  // They answer her, sometimes.
  machine.subscribe((event) => {
    if (event.type !== 'assistant.message' || spoke.length === 0) return;
    const last = spoke.at(-1)!;
    if (last.answered || clock.now - last.at > 30 * SECOND_MS || !awake(clock.now) || person.inBurst) return;
    if (random() < 0.5) clock.setTimeout(() => !person.inBurst && burst(1 + Math.floor(random() * 3), false, () => {}), between(1, 8) * MINUTE_MS);
  });

  clock.runUntil(end);
  current.initiative?.detach();
  unsubscribe();

  // The whole run: the budget over every rolling 24 hours, the gap, no thoughts at night or at rare.
  if (options.dial !== 'off') {
    const budget = INITIATIVE_BUDGETS[options.dial];
    for (const entry of spoke) {
      const inDay = spoke.filter((other) => other.at > entry.at - INITIATIVE_WINDOW_MS && other.at <= entry.at).length;
      if (inDay > budget.perDay) violations.push(`${new Date(entry.at).toTimeString().slice(0, 5)}: ${inDay} in 24 hours, over ${budget.perDay}`);
    }
    const checkIns = spoke.filter((entry) => entry.kind !== 'opener');
    for (const [index, entry] of checkIns.entries()) {
      const previous = checkIns[index - 1];
      if (previous !== undefined && entry.at - previous.at < budget.gapMs) violations.push(`${new Date(entry.at).toTimeString().slice(0, 5)}: ${Math.round((entry.at - previous.at) / MINUTE_MS)} min after the last`);
      if (entry.kind === 'thought' && (budget.thoughtQuietMs === null || dayPart(new Date(entry.at).getHours()) === 'night')) violations.push(`${new Date(entry.at).toTimeString().slice(0, 5)}: a thought ${budget.thoughtQuietMs === null ? 'at rare' : 'at night'}`);
    }
  }
  return { start, spoke, violations, visits, userTurns, followUps: 3 * Math.ceil((end - t0) / (24 * HOUR_MS)) };
}
