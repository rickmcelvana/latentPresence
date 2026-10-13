import type { Schedule, ScheduleRun } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from '../memory/fake-store';
import { Schedules, type SchedulesOptions } from './schedules';

const CHICAGO = 'America/Chicago';
// Tuesday 2026-10-13 10:00 in Chicago (CDT).
const NOW = '2026-10-13T15:00:00.000Z';

function rig(overrides: Partial<SchedulesOptions> & { now?: () => Date } = {}) {
  const store = new FakeMemoryStore();
  let clock = new Date(NOW);
  let ids = 0;
  const schedules = new Schedules({
    store,
    characterId: 'alice',
    timeZone: CHICAGO,
    companion: false,
    now: () => clock,
    newId: () => `s${(ids += 1)}`,
    ...overrides,
  });
  return { store, schedules, set: (iso: string) => (clock = new Date(iso)) };
}

async function made(schedules: Schedules, request: Parameters<Schedules['create']>[0]): Promise<Schedule> {
  const outcome = await schedules.create(request);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.schedule;
}

async function refused(schedules: Schedules, request: Parameters<Schedules['create']>[0]): Promise<string> {
  const outcome = await schedules.create(request);
  if (outcome.ok) throw new Error('should have been refused');
  return outcome.reason;
}

const run = (overrides: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: 'r1',
  scheduleId: 's1',
  startedAt: '2026-10-13T16:00:00.000Z',
  finishedAt: '2026-10-13T16:00:01.000Z',
  outcome: 'ok',
  summary: 'done',
  error: null,
  scheduledFor: null,
  deliveredAt: null,
  ...overrides,
});

describe('Schedules.create (P6-T08, ADR-58)', () => {
  it('turns "at" into the instant it names in the person\'s zone, and saves a plain reminder', async () => {
    const { schedules, store } = rig();
    const saved = await made(schedules, { description: '  call the vet ', at: '2026-10-15T09:00' });
    expect(saved).toEqual({
      id: 's1',
      characterId: 'alice',
      description: 'call the vet',
      trigger: { kind: 'once', at: '2026-10-15T14:00:00.000Z' },
      taskPrompt: '',
      allowedTools: [],
      delivery: 'notify',
      catchUp: 'run_once',
      runOn: 'core',
      status: 'active',
      lastRunAt: null,
      nextRunAt: '2026-10-15T14:00:00.000Z',
      createdAt: NOW,
      toolCall: null,
      lastRun: null,
    });
    expect(await store.listSchedules('alice')).toEqual([saved]);
    expect(schedules.snapshot()).toEqual([saved]);
  });

  it('"in_minutes" is a one-shot from now; "repeat" is a cron in the zone whose first run is the next firing, catching up with skip', async () => {
    const { schedules } = rig();
    expect(await made(schedules, { description: 'tea', inMinutes: 20 })).toMatchObject({ trigger: { kind: 'once', at: '2026-10-13T15:20:00.000Z' }, nextRunAt: '2026-10-13T15:20:00.000Z', catchUp: 'run_once' });
    expect(await made(schedules, { description: 'stretch', repeat: ' 0 9 * * * ' })).toMatchObject({
      trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: CHICAGO },
      nextRunAt: '2026-10-14T14:00:00.000Z',
      catchUp: 'skip',
    });
    expect(await made(schedules, { description: 'weekly', repeat: '0 9 * * 1', catchUp: 'run_all', delivery: 'silent_log' })).toMatchObject({ catchUp: 'run_all', delivery: 'silent_log' });
  });

  it('a reminder runs on the companion when memory is the companion; a task always runs in the core', async () => {
    const { schedules } = rig({ companion: true, toolNames: () => ['notes_read'] });
    expect(await made(schedules, { description: 'a', inMinutes: 5 })).toMatchObject({ runOn: 'companion' });
    expect(await made(schedules, { description: 'b', inMinutes: 5, task: 'summarise my notes', tools: ['notes_read'] })).toMatchObject({
      runOn: 'core',
      taskPrompt: 'summarise my notes',
      allowedTools: ['notes_read'],
    });
  });

  it('refuses anything but exactly one of at, in_minutes and repeat, saying which to give', async () => {
    const { schedules, store } = rig();
    expect(await refused(schedules, { description: 'x' })).toMatch(/exactly one of "at".*"in_minutes".*"repeat"/u);
    expect(await refused(schedules, { description: 'x', at: '2026-10-15T09:00', inMinutes: 5 })).toMatch(/exactly one/u);
    expect(await refused(schedules, { description: 'x', inMinutes: 5, repeat: '0 9 * * *' })).toMatch(/exactly one/u);
    expect(await store.listSchedules('alice')).toEqual([]);
  });

  it('refuses a description that is empty or too long', async () => {
    const { schedules } = rig();
    expect(await refused(schedules, { description: '   ', inMinutes: 5 })).toMatch(/1 to 200/u);
    expect(await refused(schedules, { description: 'x'.repeat(201), inMinutes: 5 })).toMatch(/1 to 200/u);
    expect(await made(schedules, { description: 'x'.repeat(200), inMinutes: 5 })).toMatchObject({ description: 'x'.repeat(200) });
  });

  it('refuses a time that is not a time, and one already past with what time it is now', async () => {
    const { schedules } = rig();
    expect(await refused(schedules, { description: 'x', at: 'Thursday at 9' })).toMatch(/not a time — give YYYY-MM-DDTHH:MM.*2026-10-14T09:00/u);
    expect(await refused(schedules, { description: 'x', at: '2026-02-30T09:00' })).toMatch(/not a time/u);
    expect(await refused(schedules, { description: 'x', at: '2026-10-13T09:00' })).toMatch(/already passed.*Tuesday 13 October at 10:00/u);
    expect(await refused(schedules, { description: 'x', at: '2026-10-13T10:00' })).toMatch(/already passed/u);
    expect(await made(schedules, { description: 'x', at: '2026-10-13T10:01' })).toMatchObject({ nextRunAt: '2026-10-13T15:01:00.000Z' });
  });

  it('refuses minutes that are not whole or out of range, and a repeat that does not parse (the cron\'s own reason)', async () => {
    const { schedules } = rig();
    for (const inMinutes of [0, -5, 1.5, 10_081]) expect(await refused(schedules, { description: 'x', inMinutes })).toMatch(/whole number of minutes from 1 to 10080/u);
    expect(await made(schedules, { description: 'x', inMinutes: 10_080 })).toMatchObject({ nextRunAt: '2026-10-20T15:00:00.000Z' });
    expect(await refused(schedules, { description: 'x', repeat: '0 0 9 * * *' })).toMatch(/cannot repeat.*(six|6) fields/iu);
    expect(await refused(schedules, { description: 'x', repeat: 'every morning' })).toMatch(/cannot repeat/u);
    expect(await refused(schedules, { description: 'x', repeat: '0 9 31 2 *' })).toMatch(/never comes round/u);
  });

  it('refuses tools without a task, and a task naming a tool she does not have, listing hers', async () => {
    const { schedules } = rig({ toolNames: () => ['notes_read', 'plan_list'] });
    expect(await refused(schedules, { description: 'x', inMinutes: 5, tools: ['notes_read'] })).toMatch(/go with a "task"/u);
    expect(await refused(schedules, { description: 'x', inMinutes: 5, task: 'do it', tools: ['notes_read', 'rm_rf'] })).toMatch(/do not have a tool called "rm_rf".*notes_read, plan_list/u);
    expect(await made(schedules, { description: 'x', inMinutes: 5, task: 'do it', tools: ['plan_list'] })).toMatchObject({ allowedTools: ['plan_list'] });
  });

  it('a wall time the clocks skip is when the gap ends, as a cron job would run it', async () => {
    const { schedules } = rig();
    // 2027-03-14 02:30 does not exist in Chicago; the gap ends at 03:00 CDT = 08:00Z.
    expect(await made(schedules, { description: 'x', at: '2027-03-14T02:30' })).toMatchObject({ nextRunAt: '2027-03-14T08:00:00.000Z' });
  });
});

describe('Schedules: find, pause, resume, cancel (P6-T08)', () => {
  it('finds by id, else by description ignoring case and spacing, the newest active one first', async () => {
    const { schedules, set } = rig();
    const old = await made(schedules, { description: 'Call the vet', inMinutes: 10 });
    set('2026-10-13T16:00:00.000Z');
    const newer = await made(schedules, { description: 'call  THE vet', inMinutes: 10 });
    expect(schedules.find(old.id)?.id).toBe(old.id);
    expect(schedules.find('  Call the   vet ')?.id).toBe(newer.id);
    await schedules.cancel(newer.id);
    expect(schedules.find('call the vet')?.id).toBe(old.id);
    await schedules.cancel(old.id);
    expect(schedules.find('call the vet')?.id).toBe(newer.id);
    expect(schedules.find('nothing')).toBeNull();
    expect(schedules.find('')).toBeNull();
  });

  it('pause only from active, resume only from paused, cancel from either; anything else is refused in words', async () => {
    const { schedules } = rig();
    const a = await made(schedules, { description: 'a', repeat: '0 9 * * *' });
    const paused = await schedules.pause('a');
    expect(paused).toMatchObject({ ok: true, schedule: { status: 'paused' } });
    expect(await schedules.pause('a')).toMatchObject({ ok: false, reason: expect.stringMatching(/"a" is paused, so it cannot be paused/u) });
    expect(await schedules.resume('a')).toMatchObject({ ok: true, schedule: { status: 'active' } });
    expect(await schedules.resume('a')).toMatchObject({ ok: false, reason: expect.stringMatching(/is active, so it cannot be resumed/u) });
    expect(await schedules.pause(a.id)).toMatchObject({ ok: true });
    expect(await schedules.cancel('a')).toMatchObject({ ok: true, schedule: { status: 'cancelled', nextRunAt: null } });
    expect(await schedules.cancel('a')).toMatchObject({ ok: false, reason: expect.stringMatching(/is cancelled, so it cannot be cancelled/u) });
    expect(await schedules.pause('a')).toMatchObject({ ok: false });
    expect(await schedules.resume('a')).toMatchObject({ ok: false });
  });

  it('cancel keeps the schedule and its history, never deleting it', async () => {
    const { schedules, store } = rig();
    await made(schedules, { description: 'a', inMinutes: 10 });
    await schedules.cancel('a');
    expect(await store.listSchedules('alice')).toEqual([expect.objectContaining({ id: 's1', status: 'cancelled', nextRunAt: null })]);
  });

  it('resume moves the next run on from now: a paused job does not catch up on what passed', async () => {
    const { schedules, set } = rig();
    await made(schedules, { description: 'a', repeat: '0 9 * * *' });
    await schedules.pause('a');
    set('2026-10-17T20:00:00.000Z');
    expect(await schedules.resume('a')).toMatchObject({ ok: true, schedule: { status: 'active', nextRunAt: '2026-10-18T14:00:00.000Z' } });
  });

  it('resume of a one-shot whose time has passed is refused', async () => {
    const { schedules, set } = rig();
    await made(schedules, { description: 'a', inMinutes: 10 });
    await schedules.pause('a');
    set('2026-10-13T15:11:00.000Z');
    const outcome = await schedules.resume('a');
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(/its time has passed — make a new one/u) });
    expect(schedules.find('a')?.status).toBe('paused');
    // Still ahead: it resumes.
    set('2026-10-13T15:05:00.000Z');
    expect(await schedules.resume('a')).toMatchObject({ ok: true, schedule: { nextRunAt: '2026-10-13T15:10:00.000Z' } });
  });

  it('an unknown name is refused listing what there is', async () => {
    const { schedules } = rig();
    expect(await schedules.cancel('x')).toMatchObject({ ok: false, reason: expect.stringMatching(/There is no schedule "x"\. Nothing is scheduled\./u) });
    await made(schedules, { description: 'water plants', inMinutes: 10 });
    expect(await schedules.cancel('x')).toMatchObject({ ok: false, reason: expect.stringMatching(/water plants \(id s1\)/u) });
  });
});

describe('Schedules: snapshot, load, subscribe, markDelivered (P6-T08)', () => {
  it('orders upcoming by next run with paused after active, then the rest by last activity, newest first', async () => {
    const { schedules, store } = rig();
    await made(schedules, { description: 'late', inMinutes: 300 });
    await made(schedules, { description: 'soon', inMinutes: 10 });
    await made(schedules, { description: 'paused-first', inMinutes: 5 });
    await made(schedules, { description: 'done-old', inMinutes: 5 });
    await made(schedules, { description: 'done-new', inMinutes: 5 });
    await schedules.pause('paused-first');
    await schedules.cancel('done-old');
    await schedules.cancel('done-new');
    // A finished one's last activity decides: give done-old a later run than done-new's creation.
    const old = schedules.find('done-old');
    if (old === null) throw new Error('missing');
    await store.saveSchedule({ ...old, lastRunAt: '2026-10-13T17:00:00.000Z' });
    await schedules.load();
    expect(schedules.snapshot().map((s) => s.description)).toEqual(['soon', 'late', 'paused-first', 'done-old', 'done-new']);
  });

  it('every load() reads the store again, and a failed read leaves what was there and is thrown', async () => {
    const { schedules, store } = rig();
    await made(schedules, { description: 'a', inMinutes: 5 });
    const seen: number[] = [];
    const stop = schedules.subscribe(() => seen.push(schedules.snapshot().length));
    // The scheduler moved it behind this object's back.
    const [stored] = await store.listSchedules('alice');
    if (stored === undefined) throw new Error('missing');
    await store.saveSchedule({ ...stored, nextRunAt: '2026-10-13T15:30:00.000Z' });
    await schedules.load();
    expect(schedules.snapshot()[0]?.nextRunAt).toBe('2026-10-13T15:30:00.000Z');
    expect(seen.length).toBeGreaterThan(0);
    const before = schedules.snapshot();
    const real = store.listSchedules.bind(store);
    store.listSchedules = async () => {
      throw new Error('the companion is down');
    };
    await expect(schedules.load()).rejects.toThrow('the companion is down');
    expect(schedules.snapshot()).toBe(before);
    store.listSchedules = real;
    await expect(schedules.load()).resolves.toBeUndefined();
    stop();
    const count = seen.length;
    await schedules.load();
    expect(seen.length).toBe(count);
  });

  it('replaces the snapshot rather than mutating it', async () => {
    const { schedules } = rig();
    await made(schedules, { description: 'a', inMinutes: 5 });
    const first = schedules.snapshot();
    await schedules.pause('a');
    expect(schedules.snapshot()).not.toBe(first);
    expect(first[0]?.status).toBe('active');
  });

  it('writes go through one queue: two made at once are both kept', async () => {
    const { schedules, store } = rig();
    await Promise.all([schedules.create({ description: 'a', inMinutes: 5 }), schedules.create({ description: 'b', inMinutes: 6 }), schedules.create({ description: 'c', inMinutes: 7 })]);
    expect((await store.listSchedules('alice')).map((s) => s.description).toSorted()).toEqual(['a', 'b', 'c']);
  });

  it('markDelivered marks the runs told and leaves untold others and already told ones alone', async () => {
    const { schedules, store } = rig();
    await made(schedules, { description: 'a', inMinutes: 5 });
    await made(schedules, { description: 'b', inMinutes: 5 });
    await made(schedules, { description: 'c', inMinutes: 5 });
    const [a, b, c] = await store.listSchedules('alice');
    if (a === undefined || b === undefined || c === undefined) throw new Error('missing');
    await store.saveSchedule({ ...a, lastRun: run({ scheduleId: a.id }) });
    await store.saveSchedule({ ...b, lastRun: run({ scheduleId: b.id }) });
    await store.saveSchedule({ ...c, lastRun: run({ scheduleId: c.id, deliveredAt: '2026-10-13T16:30:00.000Z' }) });
    await schedules.markDelivered([a.id, c.id, 'ghost'], new Date('2026-10-13T17:00:00.000Z'));
    const after = new Map((await store.listSchedules('alice')).map((s) => [s.id, s.lastRun?.deliveredAt]));
    expect(after.get(a.id)).toBe('2026-10-13T17:00:00.000Z');
    expect(after.get(b.id)).toBeNull();
    expect(after.get(c.id)).toBe('2026-10-13T16:30:00.000Z');
  });
});
