import type { LLMProvider } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from '../memory/fake-store';
import { attachDeliveries } from './deliveries';
import { agentExecutor } from './execute';
import { pendingDeliveries, attachScheduler } from './runner';
import { Schedules } from './schedules';
import { scheduleTools } from './tools';

/**
 * P6-T08's done-when, at the core: "remind me Thursday at 9 to call the vet" makes a schedule with
 * the right next run, and the reminder is said at the next session after it fires.
 */

const CHICAGO = 'America/Chicago';

/** A model that must never be asked: a reminder has no task, and no model runs for it. */
const noModel: LLMProvider = {
  id: 'no-model',
  async listModels() {
    return [];
  },
  stream() {
    throw new Error('a reminder asked the model');
  },
};

describe('P6-T08 done-when (core)', () => {
  it('creates the reminder, fires it with the page closed, and says it at the next session', async () => {
    const store = new FakeMemoryStore();
    // Tuesday 2026-10-13 10:00 in Chicago (CDT).
    let clock = Date.parse('2026-10-13T15:00:00.000Z');
    const now = (): Date => new Date(clock);

    // Session one: she is asked, and calls the tool with the date she worked out from RIGHT NOW.
    const first = new Schedules({ store, characterId: 'alice', timeZone: CHICAGO, companion: false, now });
    const tools = scheduleTools({ schedules: first, runNow: async () => null, timeZone: CHICAGO, now });
    const create = tools.find((tool) => tool.definition.name === 'schedule_create');
    if (create === undefined) throw new Error('no schedule_create');
    const args = { description: 'call the vet', at: '2026-10-15T09:00' };
    const reply = await create.run(args, { call: { id: 'c', name: 'schedule_create', arguments: args, source: 'llm', requestedAt: now().toISOString() } });
    expect(reply).toMatchObject({ saved: { description: 'call the vet', when: 'Thursday 15 October at 09:00 (in 1 day and 23 hours)', repeats: null, runs_on: 'core' } });
    const [saved] = await store.listSchedules('alice');
    expect(saved).toMatchObject({ nextRunAt: '2026-10-15T14:00:00.000Z', status: 'active', delivery: 'notify', catchUp: 'run_once' });

    // Thursday 09:00:30, nobody has the page open until a tab wakes and ticks the scheduler.
    clock = Date.parse('2026-10-15T14:00:30.000Z');
    const scheduler = attachScheduler({
      store,
      characterId: 'alice',
      execute: agentExecutor({ llm: noModel, modelId: 'm', character: { name: 'Alice' }, tools: () => [] }),
      now: () => clock,
    });
    await scheduler.tick();
    scheduler.detach();
    const kept = await store.listSchedules('alice');
    expect(kept[0]).toMatchObject({ status: 'completed', nextRunAt: null, lastRun: { outcome: 'ok', summary: 'call the vet', scheduledFor: '2026-10-15T14:00:00.000Z', deliveredAt: null } });
    expect(pendingDeliveries(kept)).toHaveLength(1);

    // The next session: a new Schedules and a new attachDeliveries, the page visible and she free.
    const second = new Schedules({ store, characterId: 'alice', timeZone: CHICAGO, companion: false, now });
    const cues: string[] = [];
    const deliveries = attachDeliveries(
      { getState: () => 'idle' },
      { schedules: second, chat: { speakUp: (cue) => (cues.push(cue), true) }, blocked: () => false, visible: () => true, timeZone: CHICAGO, now },
    );
    expect(await deliveries.tick()).toBe(true);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toContain('call the vet');
    expect(cues[0]).toContain('it is time now');
    expect(pendingDeliveries(await store.listSchedules('alice'))).toEqual([]);
    // Said once.
    expect(await deliveries.tick()).toBe(false);
    expect(cues).toHaveLength(1);
    deliveries.detach();
  });
});
