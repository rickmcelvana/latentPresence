import type { ConversationState, Schedule, ScheduleRun } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import type { Scheduler } from '../conversation/machine';
import { FakeMemoryStore } from '../memory/fake-store';
import { settle } from '../testing/scripted';
import { attachDeliveries, deliveryCue } from './deliveries';
import { Schedules } from './schedules';

const CHICAGO = 'America/Chicago';
// Thursday 2026-10-15 09:00:30 in Chicago, thirty seconds after a 09:00 reminder.
const NOW = new Date('2026-10-15T14:00:30.000Z');

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    characterId: 'alice',
    description: 'call the vet',
    trigger: { kind: 'once', at: '2026-10-15T14:00:00.000Z' },
    taskPrompt: '',
    allowedTools: [],
    delivery: 'notify',
    catchUp: 'run_once',
    runOn: 'core',
    status: 'completed',
    lastRunAt: '2026-10-15T14:00:30.000Z',
    nextRunAt: null,
    createdAt: '2026-10-13T15:00:00.000Z',
    toolCall: null,
    lastRun: null,
    ...overrides,
  };
}

function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'r1',
    scheduleId: 's1',
    startedAt: '2026-10-15T14:00:30.000Z',
    finishedAt: '2026-10-15T14:00:30.000Z',
    outcome: 'ok',
    summary: 'call the vet',
    error: null,
    scheduledFor: '2026-10-15T14:00:00.000Z',
    deliveredAt: null,
    ...overrides,
  };
}

/** A schedule whose run is waiting to be told. */
const pending = (overrides: Partial<Schedule> = {}, runOverrides: Partial<ScheduleRun> = {}): Schedule => schedule({ lastRun: run(runOverrides), ...overrides });

async function rig(
  jobs: readonly Schedule[],
  options: { visible?: boolean; blocked?: boolean; state?: ConversationState; speakUp?: boolean; notify?: (job: Schedule, run: ScheduleRun) => Promise<boolean>; now?: Date } = {},
) {
  const store = new FakeMemoryStore();
  for (const job of jobs) await store.saveSchedule(job);
  const schedules = new Schedules({ store, characterId: 'alice', timeZone: CHICAGO, companion: false, now: () => options.now ?? NOW });
  const cues: string[] = [];
  const errors: string[] = [];
  const state = { visible: options.visible ?? true, blocked: options.blocked ?? false, machine: options.state ?? 'idle', speakUp: options.speakUp ?? true };
  const deliveries = attachDeliveries(
    { getState: () => state.machine },
    {
      schedules,
      chat: {
        speakUp: (cue) => {
          cues.push(cue);
          return state.speakUp;
        },
      },
      blocked: () => state.blocked,
      visible: () => state.visible,
      ...(options.notify === undefined ? {} : { notify: options.notify }),
      timeZone: CHICAGO,
      now: () => options.now ?? NOW,
      onError: (error) => errors.push(error.message),
    },
  );
  const told = async (): Promise<(string | null | undefined)[]> => (await store.listSchedules('alice')).map((job) => job.lastRun?.deliveredAt);
  return { store, schedules, deliveries, cues, errors, state, told };
}

describe('attachDeliveries (P6-T08, ADR-58)', () => {
  it('hidden, with a notify that shows it: told, and she does not speak', async () => {
    const shown: string[] = [];
    const r = await rig([pending()], {
      visible: false,
      notify: async (job, made) => {
        shown.push(`${job.description}|${made.id}`);
        return true;
      },
    });
    expect(await r.deliveries.tick()).toBe(false);
    expect(shown).toEqual(['call the vet|r1']);
    expect(r.cues).toEqual([]);
    expect(await r.told()).toEqual([NOW.toISOString()]);
    // Told once: the next tick shows nothing more.
    await r.deliveries.tick();
    expect(shown).toHaveLength(1);
  });

  it('hidden, with a notify that throws or says no: it waits, and the error is reported', async () => {
    const throwing = await rig([pending()], {
      visible: false,
      notify: async () => {
        throw new Error('blocked by the browser');
      },
    });
    expect(await throwing.deliveries.tick()).toBe(false);
    expect(await throwing.told()).toEqual([null]);
    expect(throwing.errors).toEqual(['blocked by the browser']);
    const declining = await rig([pending()], { visible: false, notify: async () => false });
    await declining.deliveries.tick();
    expect(await declining.told()).toEqual([null]);
    expect(declining.cues).toEqual([]);
    const none = await rig([pending()], { visible: false });
    await none.deliveries.tick();
    expect(await none.told()).toEqual([null]);
  });

  it('hidden: only notify-delivery runs go to the notifier; a speak_next_session one waits to be said', async () => {
    const shown: string[] = [];
    const r = await rig([pending({ id: 'n', delivery: 'notify' }), pending({ id: 's', delivery: 'speak_next_session' })], {
      visible: false,
      notify: async (job) => {
        shown.push(job.id);
        return true;
      },
    });
    await r.deliveries.tick();
    expect(shown).toEqual(['n']);
    const [first, second] = (await r.store.listSchedules('alice')).map((job) => job.lastRun?.deliveredAt);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('visible but blocked (typing, a voice panel, a prompt), or the machine busy: it waits', async () => {
    const blocked = await rig([pending()], { blocked: true });
    expect(await blocked.deliveries.tick()).toBe(false);
    expect(blocked.cues).toEqual([]);
    expect(await blocked.told()).toEqual([null]);
    for (const state of ['thinking', 'speaking', 'interrupted'] as const) {
      const busy = await rig([pending()], { state });
      expect(await busy.deliveries.tick()).toBe(false);
      expect(busy.cues).toEqual([]);
    }
    // Free again: it is said.
    blocked.state.blocked = false;
    expect(await blocked.deliveries.tick()).toBe(true);
  });

  it('visible and free (idle or listening): one speakUp for everything pending, and all of it told', async () => {
    for (const state of ['idle', 'listening'] as const) {
      const r = await rig([pending({ id: 'a', description: 'call the vet' }), pending({ id: 'b', description: 'water the plants' }), schedule({ id: 'c' })], { state });
      expect(await r.deliveries.tick()).toBe(true);
      expect(r.cues).toHaveLength(1);
      expect(r.cues[0]).toContain('call the vet');
      expect(r.cues[0]).toContain('water the plants');
      const times = await r.told();
      expect(times.filter((time) => time === NOW.toISOString())).toHaveLength(2);
      expect(await r.deliveries.tick()).toBe(false);
      expect(r.cues).toHaveLength(1);
    }
  });

  it('speakUp declining (she is mid-answer): nothing is told, and the next tick tries again', async () => {
    const r = await rig([pending()], { speakUp: false });
    expect(await r.deliveries.tick()).toBe(false);
    expect(r.cues).toHaveLength(1);
    expect(await r.told()).toEqual([null]);
    r.state.speakUp = true;
    expect(await r.deliveries.tick()).toBe(true);
    expect(await r.told()).toEqual([NOW.toISOString()]);
  });

  it('with nothing pending it asks nothing of her; a store that cannot be read is reported, not thrown', async () => {
    const r = await rig([schedule({ lastRun: run({ deliveredAt: '2026-10-15T14:01:00.000Z' }) })]);
    expect(await r.deliveries.tick()).toBe(false);
    expect(r.cues).toEqual([]);
    r.store.listSchedules = async () => {
      throw new Error('the companion is down');
    };
    expect(await r.deliveries.tick()).toBe(false);
    expect(r.errors).toEqual(['the companion is down']);
  });

  it('does not overlap itself', async () => {
    const r = await rig([pending()]);
    const [a, b] = await Promise.all([r.deliveries.tick(), r.deliveries.tick()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(r.cues).toHaveLength(1);
  });

  it('ticks on its own every tickMs once attached, until detached', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const scheduler: Scheduler = { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => undefined };
    const store = new FakeMemoryStore();
    const schedules = new Schedules({ store, characterId: 'alice', timeZone: CHICAGO, companion: false, now: () => NOW });
    const cues: string[] = [];
    const attached = attachDeliveries(
      { getState: () => 'idle' },
      { schedules, chat: { speakUp: (cue) => (cues.push(cue), true) }, blocked: () => false, visible: () => true, timeZone: CHICAGO, scheduler, tickMs: 30_000, now: () => NOW },
    );
    expect(timers.at(-1)?.ms).toBe(30_000);
    await store.saveSchedule(pending());
    timers.at(-1)?.fn();
    await settle();
    expect(cues).toHaveLength(1);
    attached.detach();
    const before = timers.length;
    timers.at(-1)?.fn();
    await settle();
    expect(timers.length).toBe(before);
  });
});

describe('deliveryCue (P6-T08)', () => {
  it('a reminder on time is the friend\'s voice: what they asked, that it is time now', () => {
    expect(deliveryCue([{ schedule: schedule(), run: run() }], NOW, CHICAGO)).toBe(
      '(They asked you to remind them about this, and it is time now: "call the vet". Remind them in one or two short sentences, the way a friend would.)',
    );
  });

  it('a late one says when it was due, in the past tense, beyond five minutes', () => {
    const cue = deliveryCue([{ schedule: schedule(), run: run() }], new Date('2026-10-15T15:30:00.000Z'), CHICAGO);
    expect(cue).toContain('"call the vet"');
    expect(cue).toContain('It was due at 09:00 this morning, while they were away — say so.');
    expect(cue).not.toContain('it is time now');
    // Within five minutes it is on time.
    expect(deliveryCue([{ schedule: schedule(), run: run() }], new Date('2026-10-15T14:05:00.000Z'), CHICAGO)).not.toContain('It was due');
    expect(deliveryCue([{ schedule: schedule(), run: run() }], new Date('2026-10-15T14:05:01.000Z'), CHICAGO)).toContain('It was due at 09:00 this morning');
    expect(deliveryCue([{ schedule: schedule(), run: run() }], new Date('2026-10-16T16:00:00.000Z'), CHICAGO)).toContain('It was due at 09:00 yesterday');
    expect(deliveryCue([{ schedule: schedule(), run: run() }], new Date('2026-10-19T16:00:00.000Z'), CHICAGO)).toContain('It was due on Thursday 15 October at 09:00');
  });

  it('a task\'s result carries its summary; a failed run passes its own failure through', () => {
    const task = schedule({ description: 'summarise the inbox', taskPrompt: 'summarise it' });
    expect(deliveryCue([{ schedule: task, run: run({ summary: 'Three emails need a reply' }) }], NOW, CHICAGO)).toBe(
      '(Something you did for them on a schedule finished — "summarise the inbox": Three emails need a reply. Tell them in a sentence or two.)',
    );
    const failed = run({ outcome: 'failed', summary: 'I couldn\'t do "summarise the inbox": the model is off', error: 'the model is off' });
    const cue = deliveryCue([{ schedule: task, run: failed }], NOW, CHICAGO);
    expect(cue).toContain('did not work');
    expect(cue).toContain('I couldn\'t do "summarise the inbox": the model is off.');
  });

  it('several are one numbered cue', () => {
    const cue = deliveryCue(
      [
        { schedule: schedule({ description: 'call the vet' }), run: run() },
        { schedule: schedule({ id: 's2', description: 'summarise the inbox', taskPrompt: 'go' }), run: run({ summary: 'Two emails' }) },
      ],
      NOW,
      CHICAGO,
    );
    expect(cue.startsWith('(')).toBe(true);
    expect(cue.endsWith(')')).toBe(true);
    expect(cue).toMatch(/\n1\. They asked you to remind them about this, and it is time now: "call the vet"\./u);
    expect(cue).toMatch(/\n2\. Something you did for them on a schedule finished — "summarise the inbox": Two emails\./u);
  });
});
