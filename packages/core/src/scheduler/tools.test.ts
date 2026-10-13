import type { JsonValue, ScheduleRun } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from '../memory/fake-store';
import { Schedules } from './schedules';
import { scheduleTools } from './tools';

const CHICAGO = 'America/Chicago';
// Tuesday 2026-10-13 10:00 in Chicago (CDT).
const NOW = new Date('2026-10-13T15:00:00.000Z');

function setup(options: { runNow?: (id: string) => Promise<ScheduleRun | null>; companion?: boolean } = {}) {
  const store = new FakeMemoryStore();
  let ids = 0;
  const schedules = new Schedules({
    store,
    characterId: 'alice',
    timeZone: CHICAGO,
    companion: options.companion ?? false,
    toolNames: () => ['notes_read'],
    now: () => NOW,
    newId: () => `s${(ids += 1)}`,
  });
  const ran: string[] = [];
  const tools = scheduleTools({
    schedules,
    timeZone: CHICAGO,
    now: () => NOW,
    runNow:
      options.runNow ??
      (async (id) => {
        ran.push(id);
        return { id: 'r1', scheduleId: id, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), outcome: 'ok', summary: 'Call the vet', error: null, scheduledFor: NOW.toISOString(), deliveredAt: NOW.toISOString() };
      }),
  });
  const run = async (name: string, args: Record<string, JsonValue>): Promise<JsonValue> => {
    const tool = tools.find((candidate) => candidate.definition.name === name);
    if (tool === undefined) throw new Error(`no ${name}`);
    return tool.run(args, { call: { id: 'c', name, arguments: args, source: 'llm', requestedAt: NOW.toISOString() } });
  };
  return { store, schedules, tools, run, ran };
}

describe('schedule tools (P6-T08, ADR-58)', () => {
  it('are named with underscores and each asks only for what it needs', () => {
    const { tools } = setup();
    expect(tools.map((tool) => [tool.definition.name, (tool.definition.parameters as { required?: string[] }).required ?? []])).toEqual([
      ['schedule_create', ['description']],
      ['schedule_list', []],
      ['schedule_cancel', ['schedule']],
      ['schedule_run_now', ['schedule']],
    ]);
  });

  it('schedule_create says what the live check reads: when to use it, the wall-clock "at", and to say the reply\'s "when" back', () => {
    const description = setup().tools[0]?.definition.description ?? '';
    expect(description).toMatch(/remind me/u);
    expect(description).toMatch(/every morning/u);
    expect(description).toMatch(/plan_follow_up/u);
    expect(description).toMatch(/THEIR local time/u);
    expect(description).toMatch(/RIGHT NOW/u);
    expect(description).toMatch(/Thursday at 9/u);
    expect(description).toMatch(/"when", WORD FOR WORD/u);
    expect(description).toMatch(/schedule_cancel/u);
    expect(description).toMatch(/Leave out "task" for a plain reminder/u);
  });

  it('schedule_create saves it and replies with the code\'s own words for when, never the model\'s', async () => {
    const { run, store } = setup();
    expect(await run('schedule_create', { description: 'call the vet', at: '2026-10-15T09:00' })).toEqual({
      saved: { id: 's1', description: 'call the vet', when: 'Thursday 15 October at 09:00 (in 1 day and 23 hours)', repeats: null, runs_on: 'core' },
    });
    expect(await store.listSchedules('alice')).toEqual([expect.objectContaining({ nextRunAt: '2026-10-15T14:00:00.000Z', description: 'call the vet' })]);
  });

  it('schedule_create names a repeat in words when it can, and by its expression when it cannot', async () => {
    const { run } = setup({ companion: true });
    expect(await run('schedule_create', { description: 'stretch', repeat: '30 7 * * 1-5' })).toMatchObject({ saved: { when: 'tomorrow at 07:30 (in 21 hours and 30 minutes)', repeats: 'weekdays at 07:30', runs_on: 'companion' } });
    expect(await run('schedule_create', { description: 'rent', repeat: '0 9 1 * *' })).toMatchObject({ saved: { repeats: '0 9 1 * *' } });
    expect(await run('schedule_create', { description: 'tea', in_minutes: 20 })).toMatchObject({ saved: { when: 'today at 10:20 (in 20 minutes)', repeats: null } });
  });

  it('schedule_create takes in_minutes and tools as the strings a model may send, and a task with tools it has', async () => {
    const { run, schedules } = setup();
    expect(await run('schedule_create', { description: 'summary', in_minutes: '30', task: 'summarise my notes', tools: '["notes_read"]', delivery: 'speak_next_session', catch_up: 'skip' })).toMatchObject({
      saved: { runs_on: 'core' },
    });
    expect(schedules.snapshot()[0]).toMatchObject({ taskPrompt: 'summarise my notes', allowedTools: ['notes_read'], delivery: 'speak_next_session', catchUp: 'skip', nextRunAt: '2026-10-13T15:30:00.000Z' });
  });

  it('schedule_create refusals are results she can act on, never throws', async () => {
    const { run } = setup();
    expect(await run('schedule_create', { description: 'x' })).toEqual({ error: expect.stringMatching(/exactly one of "at"/u) });
    expect(await run('schedule_create', { description: 'x', at: '2026-10-13T09:00' })).toEqual({ error: expect.stringMatching(/already passed.*Tuesday 13 October at 10:00/u) });
    expect(await run('schedule_create', { description: 'x', at: 'Thursday at 9' })).toEqual({ error: expect.stringMatching(/not a time — give YYYY-MM-DDTHH:MM/u) });
    expect(await run('schedule_create', { description: 'x', repeat: 'nope' })).toEqual({ error: expect.stringMatching(/cannot repeat/u) });
    expect(await run('schedule_create', { description: 'x', in_minutes: 5, task: 'go', tools: ['rm_rf'] })).toEqual({ error: expect.stringMatching(/do not have a tool called "rm_rf".*notes_read/u) });
    expect(await run('schedule_create', { at: '2026-10-15T09:00' })).toEqual({ error: expect.stringMatching(/Not saved — description/u) });
    expect(await run('schedule_create', { description: 'x', in_minutes: 'soon' })).toEqual({ error: expect.stringMatching(/Not saved — in_minutes/u) });
    expect(await run('schedule_create', { description: 'x', delivery: 'shout', in_minutes: 5 })).toEqual({ error: expect.stringMatching(/Not saved — delivery/u) });
  });

  it('schedule_create then schedule_list is a round trip: upcoming, with when in words and the repeat', async () => {
    const { run } = setup();
    await run('schedule_create', { description: 'call the vet', at: '2026-10-15T09:00' });
    await run('schedule_create', { description: 'stretch', repeat: '0 18 * * 0' });
    expect(await run('schedule_list', {})).toEqual({
      schedules: [
        { id: 's1', description: 'call the vet', status: 'active', when: 'Thursday 15 October at 09:00 (in 1 day and 23 hours)', repeats: null, last: null },
        { id: 's2', description: 'stretch', status: 'active', when: 'Sunday 18 October at 18:00 (in 5 days and 8 hours)', repeats: 'every Sunday at 18:00', last: null },
      ],
    });
  });

  it('schedule_list leaves out the finished unless asked, gives them no "when", and shows the last result', async () => {
    const { run, store } = setup();
    await run('schedule_create', { description: 'old one', in_minutes: 5 });
    await run('schedule_create', { description: 'new one', in_minutes: 50 });
    await run('schedule_cancel', { schedule: 'old one' });
    const [, fresh] = await store.listSchedules('alice');
    if (fresh === undefined) throw new Error('missing');
    await store.saveSchedule({
      ...fresh,
      lastRun: { id: 'r', scheduleId: fresh.id, startedAt: '2026-10-13T14:00:00.000Z', finishedAt: '2026-10-13T14:00:02.000Z', outcome: 'ok', summary: 'Done it.', error: null, scheduledFor: null, deliveredAt: null },
    });
    expect(await run('schedule_list', {})).toEqual({
      schedules: [{ id: 's2', description: 'new one', status: 'active', when: 'today at 10:50 (in 50 minutes)', repeats: null, last: { outcome: 'ok', summary: 'Done it.', at: 'at 09:00 this morning' } }],
    });
    expect(await run('schedule_list', { include_finished: true })).toMatchObject({
      schedules: [{ description: 'new one' }, { description: 'old one', status: 'cancelled', when: null }],
    });
    expect(await run('schedule_list', { include_finished: 'yes' })).toMatchObject({ schedules: [{ description: 'new one' }] });
  });

  it('schedule_cancel by description or id, keeps it as cancelled, and says why when it cannot', async () => {
    const { run, schedules } = setup();
    await run('schedule_create', { description: 'Call the vet', at: '2026-10-15T09:00' });
    expect(await run('schedule_cancel', { schedule: 'call the VET' })).toEqual({ cancelled: { id: 's1', description: 'Call the vet' } });
    expect(schedules.find('s1')?.status).toBe('cancelled');
    expect(await run('schedule_cancel', { schedule: 's1' })).toEqual({ error: expect.stringMatching(/is cancelled, so it cannot be cancelled/u) });
    expect(await run('schedule_cancel', { schedule: 'ghost' })).toEqual({ error: expect.stringMatching(/There is no schedule "ghost"\. Nothing is scheduled\./u) });
    expect(await run('schedule_cancel', {})).toEqual({ error: expect.stringMatching(/Name the schedule/u) });
  });

  it('schedule_run_now runs it and returns the result for her to say; it says why when it cannot', async () => {
    const { run, ran } = setup();
    await run('schedule_create', { description: 'Call the vet', in_minutes: 60 });
    expect(await run('schedule_run_now', { schedule: 'call the vet' })).toEqual({ ran: { outcome: 'ok', summary: 'Call the vet' } });
    expect(ran).toEqual(['s1']);
    expect(await run('schedule_run_now', { schedule: 'ghost' })).toEqual({ error: expect.stringMatching(/There is no schedule "ghost".*Call the vet \(id s1\)/u) });
    expect(await run('schedule_run_now', {})).toEqual({ error: expect.stringMatching(/Name the schedule/u) });

    const refusing = setup({ runNow: async () => null });
    await refusing.run('schedule_create', { description: 'Call the vet', in_minutes: 60 });
    expect(await refusing.run('schedule_run_now', { schedule: 'call the vet' })).toEqual({ error: expect.stringMatching(/could not be run from here/u) });
    const [stored] = await refusing.store.listSchedules('alice');
    if (stored === undefined) throw new Error('missing');
    await refusing.store.saveSchedule({ ...stored, runOn: 'companion', toolCall: { serverId: 'home', name: 'lights_on', arguments: {} } });
    expect(await refusing.run('schedule_run_now', { schedule: 'call the vet' })).toEqual({ error: expect.stringMatching(/companion runs/u) });
  });
});
