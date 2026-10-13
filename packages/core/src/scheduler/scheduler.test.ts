import type { CancellationSignal, LLMProvider, LlmRequest, LlmStreamChunk, Schedule, ScheduleRun } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import type { Scheduler } from '../conversation/machine';
import { FakeMemoryStore } from '../memory/fake-store';
import { deferred, settle } from '../testing/scripted';
import type { LocalTool } from '../self/tools';
import { CronError, firingsBetween, nextFiring, parseCron, wallTimeToInstant } from './cron';
import { SCHEDULE_MARKER, agentExecutor, type ScheduleExecutor } from './execute';
import { LATE_GRACE_MS, RUN_ALL_LIMIT, planSchedule } from './plan';
import { attachScheduler, markDelivered, pendingDeliveries, scheduleSessionId } from './runner';
import { simulateScheduleWeek, toronto } from './simulate';

const TZ = 'America/Toronto';
const MINUTE = 60_000;
const at = (iso: string): Date => new Date(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    characterId: 'alice',
    description: 'Call the vet',
    trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: TZ },
    taskPrompt: '',
    allowedTools: [],
    delivery: 'speak_next_session',
    catchUp: 'run_once',
    runOn: 'core',
    status: 'active',
    lastRunAt: null,
    nextRunAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    toolCall: null,
    lastRun: null,
    ...overrides,
  };
}

describe('cron (five fields, a zone, and the rules the companion keeps at clock changes)', () => {
  it('takes five fields in a zone, and refuses seconds, bad fields and unknown zones in words', () => {
    expect(parseCron('0 9 * * 1-5', TZ).next(at('2026-10-09T14:00:00Z'))?.toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(() => parseCron('0 0 9 * * *', TZ)).toThrow(/six fields|6 fields/u);
    expect(() => parseCron('61 * * * *', TZ)).toThrow(CronError);
    expect(() => parseCron('0 9 L * *', TZ)).toThrow(/L, W or #/u);
    expect(() => parseCron('5/15 * * * *', TZ)).toThrow(/steps from a single value/u);
    expect(() => parseCron('0 9 * * *', 'Mars/Base')).toThrow(/not a time zone/u);
  });

  it('ORs day of month and day of week, as every cron does', () => {
    const cron = parseCron('0 9 13 * 1', TZ);
    // Tuesday the 13th, then Monday the 19th.
    expect(cron.next(at('2026-10-12T14:00:00Z'))?.toISOString()).toBe('2026-10-13T13:00:00.000Z');
    expect(cron.next(at('2026-10-13T14:00:00Z'))?.toISOString()).toBe('2026-10-19T13:00:00.000Z');
  });

  it('a wall-clock time is the instant it names, by the same rules at clock changes (P6-T08)', () => {
    expect(wallTimeToInstant('2026-10-15T09:00', 'America/Chicago')?.toISOString()).toBe('2026-10-15T14:00:00.000Z');
    expect(wallTimeToInstant('2026-10-15T09:00', 'Pacific/Chatham')?.toISOString()).toBe('2026-10-14T19:15:00.000Z');
    // Skipped: when the gap ends. Repeated: the first time.
    expect(wallTimeToInstant('2027-03-14T02:30', 'America/Chicago')?.toISOString()).toBe('2027-03-14T08:00:00.000Z');
    expect(wallTimeToInstant('2026-11-01T01:30', 'America/Chicago')?.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(wallTimeToInstant('2026-02-30T09:00', TZ)).toBeNull();
    expect(wallTimeToInstant('2026-10-15T24:00', TZ)).toBeNull();
    expect(wallTimeToInstant('Thursday at 9', TZ)).toBeNull();
    expect(() => wallTimeToInstant('2026-10-15T09:00', 'Mars/Olympus')).toThrow(CronError);
  });

  it('next is strictly after; a one-shot has one firing, then none', () => {
    expect(nextFiring({ kind: 'cron', expression: '0 9 * * *', timeZone: TZ }, at('2026-10-13T13:00:00Z'))?.toISOString()).toBe('2026-10-14T13:00:00.000Z');
    expect(nextFiring({ kind: 'once', at: '2026-10-15T13:00:00.000Z' }, at('2026-10-13T00:00:00Z'))?.toISOString()).toBe('2026-10-15T13:00:00.000Z');
    expect(nextFiring({ kind: 'once', at: '2026-10-15T13:00:00.000Z' }, at('2026-10-15T13:00:00Z'))).toBeNull();
  });

  it('across the spring change: a fixed time the clocks skip runs when the gap ends; every 30 minutes steps over it', () => {
    const daily = parseCron('30 2 * * *', TZ);
    expect(daily.next(at('2026-03-07T12:00:00Z'))?.toISOString()).toBe('2026-03-08T07:00:00.000Z'); // 03:00 EDT
    expect(daily.next(at('2026-03-08T07:00:00Z'))?.toISOString()).toBe('2026-03-09T06:30:00.000Z'); // and not again at 03:30
    expect(daily.next(at('2026-03-08T07:30:00Z'))?.toISOString()).toBe('2026-03-09T06:30:00.000Z'); // 02:30 EDT
    const half = firingsBetween({ kind: 'cron', expression: '*/30 * * * *', timeZone: TZ }, at('2026-03-08T06:30:00Z'), at('2026-03-08T08:00:00Z'), 10);
    expect(half.times.map((time) => time.toISOString())).toEqual(['2026-03-08T06:30:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-08T07:30:00.000Z', '2026-03-08T08:00:00.000Z']);
  });

  it('across the fall change: a fixed time that happens twice runs once, the first time; an interval job follows real time', () => {
    const daily = parseCron('30 1 * * *', TZ);
    expect(daily.next(at('2026-10-31T12:00:00Z'))?.toISOString()).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    expect(daily.next(at('2026-11-01T05:30:00Z'))?.toISOString()).toBe('2026-11-02T06:30:00.000Z'); // 01:30 EST, next day
    const hourly = firingsBetween({ kind: 'cron', expression: '0 * * * *', timeZone: TZ }, at('2026-11-01T04:00:00Z'), at('2026-11-01T08:00:00Z'), 10);
    // 00:00 EDT, 01:00 EDT, 01:00 EST, 02:00 EST, 03:00 EST: every real hour, as Vixie cron and croner-rust.
    expect(hourly.times.map((time) => time.toISOString())).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-01T05:00:00.000Z', '2026-11-01T06:00:00.000Z', '2026-11-01T07:00:00.000Z', '2026-11-01T08:00:00.000Z']);
  });
});

describe('planSchedule (each catch-up policy)', () => {
  const daily = (catchUp: Schedule['catchUp'], nextRunAt = '2026-10-10T13:00:00.000Z'): Schedule => schedule({ catchUp, nextRunAt });
  // Three days missed (10, 11, 12 Oct at 09:00), found on the 13th at 09:01: one is on time.
  const now = at('2026-10-13T13:01:00Z');

  it('runs a firing found within the grace whatever the policy, and nothing before its time', () => {
    for (const policy of ['skip', 'run_once'] as const) {
      expect(planSchedule(daily(policy, '2026-10-13T13:00:00.000Z'), now)).toEqual({ run: [at('2026-10-13T13:00:00Z')], skipped: 0, next: at('2026-10-14T13:00:00Z') });
    }
    expect(planSchedule(daily('skip', '2026-10-13T13:00:00.000Z'), at(iso(Date.parse('2026-10-13T13:00:00Z') + LATE_GRACE_MS)))?.run).toHaveLength(1);
    expect(planSchedule(daily('skip', '2026-10-14T13:00:00.000Z'), now)).toBeNull();
    expect(planSchedule(schedule({ status: 'paused', nextRunAt: '2026-10-10T13:00:00.000Z' }), now)).toBeNull();
  });

  it('skip: the missed are counted, not run; the on-time one runs', () => {
    expect(planSchedule(daily('skip'), now)).toEqual({ run: [at('2026-10-13T13:00:00Z')], skipped: 3, next: at('2026-10-14T13:00:00Z') });
    expect(planSchedule(daily('skip'), at('2026-10-13T15:00:00Z'))).toEqual({ run: [], skipped: 4, next: at('2026-10-14T13:00:00Z') });
  });

  it('run_once: one run for all that was missed, the newest', () => {
    expect(planSchedule(daily('run_once'), at('2026-10-13T15:00:00Z'))).toEqual({ run: [at('2026-10-13T13:00:00Z')], skipped: 3, next: at('2026-10-14T13:00:00Z') });
  });

  it(`run_all: every missed firing, oldest first, at most ${RUN_ALL_LIMIT}`, () => {
    expect(planSchedule(daily('run_all'), now)?.run.map((time) => time.toISOString())).toEqual([
      '2026-10-10T13:00:00.000Z',
      '2026-10-11T13:00:00.000Z',
      '2026-10-12T13:00:00.000Z',
      '2026-10-13T13:00:00.000Z',
    ]);
    const hourly = schedule({ trigger: { kind: 'cron', expression: '0 * * * *', timeZone: TZ }, catchUp: 'run_all', nextRunAt: '2026-10-12T00:00:00.000Z' });
    const plan = planSchedule(hourly, at('2026-10-13T00:30:00Z'));
    expect(plan?.run).toHaveLength(RUN_ALL_LIMIT);
    expect(plan?.run.at(-1)?.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(plan?.skipped).toBe(25 - RUN_ALL_LIMIT);
  });

  it('a one-shot has no next: it is done once planned', () => {
    const reminder = schedule({ trigger: { kind: 'once', at: '2026-10-13T13:00:00.000Z' }, nextRunAt: '2026-10-13T13:00:00.000Z', catchUp: 'skip' });
    expect(planSchedule(reminder, at('2026-10-13T18:00:00Z'))).toEqual({ run: [], skipped: 1, next: null });
  });
});

/** Answers the executor's way: ok with a summary, or a failure. */
const doing: ScheduleExecutor = async (job, when) => (job.id === 'broken' ? { ok: false, summary: '', error: 'the folder is gone' } : { ok: true, summary: `${job.description} at ${when.toISOString()}`, error: null });

async function rig(jobs: readonly Schedule[], options: { notify?: (job: Schedule, run: ScheduleRun) => Promise<boolean>; execute?: ScheduleExecutor; now?: number } = {}) {
  const store = new FakeMemoryStore();
  for (const job of jobs) await store.saveSchedule(job);
  let clock = options.now ?? Date.parse('2026-10-13T13:00:30Z');
  let ids = 0;
  const runs: ScheduleRun[] = [];
  const errors: string[] = [];
  const attached = attachScheduler({
    store,
    characterId: 'alice',
    execute: options.execute ?? doing,
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    now: () => clock,
    newId: () => `run-${(ids += 1)}`,
    onRun: (_job, run) => runs.push(run),
    onError: (error) => errors.push(error.message),
  });
  await attached.tick();
  const get = async (id: string): Promise<Schedule | undefined> => (await store.listSchedules('alice')).find((job) => job.id === id);
  return { store, attached, runs, errors, get, advance: (ms: number) => (clock += ms) };
}

const due = (overrides: Partial<Schedule>): Schedule => schedule({ nextRunAt: '2026-10-13T13:00:00.000Z', ...overrides });

describe('attachScheduler (delivery routing)', () => {
  it('runs what is due on waking, moves it on, keeps the run and writes the result into memory', async () => {
    const r = await rig([due({})]);
    const job = await r.get('s1');
    expect(job).toMatchObject({ nextRunAt: '2026-10-14T13:00:00.000Z', lastRunAt: '2026-10-13T13:00:30.000Z', status: 'active' });
    expect(job?.lastRun).toMatchObject({ outcome: 'ok', summary: 'Call the vet at 2026-10-13T13:00:00.000Z', scheduledFor: '2026-10-13T13:00:00.000Z', deliveredAt: null });
    const episodes = await r.store.listEpisodes('alice', null);
    expect(episodes).toEqual([expect.objectContaining({ role: 'assistant', sessionId: scheduleSessionId('s1'), text: 'Call the vet at 2026-10-13T13:00:00.000Z' })]);
    // Nothing more until tomorrow.
    await r.attached.tick();
    expect(r.runs).toHaveLength(1);
  });

  it('speak_next_session waits to be said; silent_log is told by being written down', async () => {
    const r = await rig([due({ id: 'speak' }), due({ id: 'quiet', delivery: 'silent_log' })]);
    expect(pendingDeliveries(await r.store.listSchedules('alice')).map((entry) => entry.schedule.id)).toEqual(['speak']);
    expect((await r.get('quiet'))?.lastRun?.deliveredAt).toBe('2026-10-13T13:00:30.000Z');
    const speak = await r.get('speak');
    if (speak === undefined) throw new Error('no schedule');
    await r.store.saveSchedule(markDelivered(speak, new Date('2026-10-13T14:00:00Z')));
    expect(pendingDeliveries(await r.store.listSchedules('alice'))).toEqual([]);
  });

  it('notify: told when the notification shows; waits to be said when it cannot, or there is no notifier', async () => {
    const shown = await rig([due({ delivery: 'notify' })], { notify: async () => true });
    expect((await shown.get('s1'))?.lastRun?.deliveredAt).not.toBeNull();
    const blocked = await rig([due({ delivery: 'notify' })], { notify: async () => false });
    expect((await blocked.get('s1'))?.lastRun?.deliveredAt).toBeNull();
    const none = await rig([due({ delivery: 'notify' })]);
    expect(pendingDeliveries(await none.store.listSchedules('alice'))).toHaveLength(1);
    const throwing = await rig([due({ delivery: 'notify' })], {
      notify: async () => {
        throw new Error('denied');
      },
    });
    expect((await throwing.get('s1'))?.lastRun?.deliveredAt).toBeNull();
    expect(throwing.errors).toEqual(['denied']);
  });

  it('a failure is told as one; a one-shot that fails is failed, not completed', async () => {
    const r = await rig([due({ id: 'broken', description: 'Re-index notes', trigger: { kind: 'once', at: '2026-10-13T13:00:00.000Z' } })]);
    const job = await r.get('broken');
    expect(job?.status).toBe('failed');
    expect(job?.lastRun).toMatchObject({ outcome: 'failed', summary: 'I couldn\'t do "Re-index notes": the folder is gone', error: 'the folder is gone' });
    const thrown = await rig([due({})], {
      execute: async () => {
        throw new Error('no model');
      },
    });
    expect((await thrown.get('s1'))?.lastRun).toMatchObject({ outcome: 'failed', error: 'no model' });
  });

  it('missed firings the policy skips are kept as a skipped run, told to nobody', async () => {
    const r = await rig([due({ catchUp: 'skip' })], { now: Date.parse('2026-10-13T18:00:00Z') });
    expect((await r.get('s1'))?.lastRun).toMatchObject({ outcome: 'skipped', summary: '', scheduledFor: '2026-10-13T13:00:00.000Z' });
    expect(pendingDeliveries(await r.store.listSchedules('alice'))).toEqual([]);
    expect(await r.store.listEpisodes('alice', null)).toEqual([]);
  });

  it('claims a firing before running it: a reload mid-run does not run it again', async () => {
    let seen: Schedule | undefined;
    const store = new FakeMemoryStore();
    await store.saveSchedule(due({}));
    const execute: ScheduleExecutor = async (job) => {
      seen = (await store.listSchedules('alice')).find((candidate) => candidate.id === job.id);
      return { ok: true, summary: 'ok', error: null };
    };
    await attachScheduler({ store, characterId: 'alice', execute, now: () => Date.parse('2026-10-13T13:00:30Z') }).tick();
    expect(seen?.nextRunAt).toBe('2026-10-14T13:00:00.000Z');
  });

  it('a schedule paused during its run stays paused; one deleted is not brought back', async () => {
    const store = new FakeMemoryStore();
    await store.saveSchedule(due({ id: 'pause-me' }));
    await store.saveSchedule(due({ id: 'delete-me' }));
    const execute: ScheduleExecutor = async (job) => {
      const current = (await store.listSchedules('alice')).find((candidate) => candidate.id === job.id);
      if (job.id === 'pause-me' && current !== undefined) await store.saveSchedule({ ...current, status: 'paused' });
      if (job.id === 'delete-me') await store.deleteSchedule(job.id);
      return { ok: true, summary: 'done', error: null };
    };
    await attachScheduler({ store, characterId: 'alice', execute, now: () => Date.parse('2026-10-13T13:00:30Z') }).tick();
    const left = await store.listSchedules('alice');
    expect(left.map((job) => [job.id, job.status])).toEqual([['pause-me', 'paused']]);
  });

  it("leaves the companion's schedules to it, and fails one in a zone it cannot read", async () => {
    const r = await rig([due({ id: 'elsewhere', runOn: 'companion' }), due({ id: 'odd', trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Mars/Base' } })]);
    expect((await r.get('elsewhere'))?.lastRun).toBeNull();
    expect(await r.get('odd')).toMatchObject({ status: 'failed', nextRunAt: null });
    expect(r.errors[0]).toMatch(/not a time zone/u);
  });

  it('ticks on its own every tickMs once attached, until detached', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const scheduler: Scheduler = {
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: () => undefined,
    };
    const store = new FakeMemoryStore();
    let clock = Date.parse('2026-10-13T12:59:00Z');
    let ran = 0;
    const attached = attachScheduler({
      store,
      characterId: 'alice',
      scheduler,
      tickMs: 30_000,
      now: () => clock,
      execute: async () => {
        ran += 1;
        return { ok: true, summary: '', error: null };
      },
    });
    await store.saveSchedule(due({}));
    await attached.tick();
    await settle();
    expect(timers.at(-1)?.ms).toBe(30_000);
    clock += 2 * MINUTE;
    timers.at(-1)?.fn();
    await settle();
    expect(ran).toBe(1);
    attached.detach();
    const before = timers.length;
    timers.at(-1)?.fn();
    await settle();
    expect(timers.length).toBe(before);
  });
});

describe('attachScheduler.runNow (P6-T08)', () => {
  const waiting = (overrides: Partial<Schedule> = {}): Schedule => schedule({ nextRunAt: '2026-10-15T14:00:00.000Z', ...overrides });

  it('runs a schedule once, now, without moving its next run or its status; the run is kept and told at once', async () => {
    const r = await rig([waiting({ delivery: 'speak_next_session' })]);
    expect(r.runs).toEqual([]);
    const run = await r.attached.runNow('s1');
    expect(run).toMatchObject({ outcome: 'ok', summary: 'Call the vet at 2026-10-13T13:00:30.000Z', scheduledFor: '2026-10-13T13:00:30.000Z', deliveredAt: run?.finishedAt });
    const job = await r.get('s1');
    expect(job).toMatchObject({ status: 'active', nextRunAt: '2026-10-15T14:00:00.000Z', lastRunAt: '2026-10-13T13:00:30.000Z' });
    expect(job?.lastRun).toEqual(run);
    expect(pendingDeliveries(await r.store.listSchedules('alice'))).toEqual([]);
    expect(r.runs).toEqual([run]);
    expect(await r.store.listEpisodes('alice', null)).toEqual([expect.objectContaining({ sessionId: scheduleSessionId('s1'), text: 'Call the vet at 2026-10-13T13:00:30.000Z' })]);
  });

  it('a reminder the companion would run may be run by the page: it needs no model', async () => {
    const r = await rig([waiting({ runOn: 'companion', description: 'Stretch' })], {
      execute: async (job) => ({ ok: true, summary: job.description, error: null }),
    });
    expect(await r.attached.runNow('s1')).toMatchObject({ outcome: 'ok', summary: 'Stretch' });
  });

  it('a failed run on demand is kept as failed and does not turn a completed one-shot into failed', async () => {
    const r = await rig([waiting({ id: 'broken', status: 'completed', nextRunAt: null, trigger: { kind: 'once', at: '2026-10-12T13:00:00.000Z' } })]);
    expect(await r.attached.runNow('broken')).toMatchObject({ outcome: 'failed', summary: 'I couldn\'t do "Call the vet": the folder is gone' });
    expect(await r.get('broken')).toMatchObject({ status: 'completed', nextRunAt: null });
  });

  it('runs nothing for a schedule that is not there, a companion tool job, or once detached', async () => {
    let ran = 0;
    const r = await rig([waiting({ id: 'tool', runOn: 'companion', toolCall: { serverId: 'home', name: 'lights_on', arguments: {} } }), waiting({ id: 'plain' })], {
      execute: async () => {
        ran += 1;
        return { ok: true, summary: 'ok', error: null };
      },
    });
    expect(await r.attached.runNow('nope')).toBeNull();
    expect(await r.attached.runNow('tool')).toBeNull();
    expect(ran).toBe(0);
    r.attached.detach();
    expect(await r.attached.runNow('plain')).toBeNull();
    expect(ran).toBe(0);
  });

  it('queues behind a pass in progress and never overlaps one', async () => {
    const store = new FakeMemoryStore();
    await store.saveSchedule(due({ id: 'due' }));
    await store.saveSchedule(waiting({ id: 'later', nextRunAt: '2026-10-20T00:00:00.000Z' }));
    const log: string[] = [];
    let open = 0;
    let overlap = false;
    const gate = deferred();
    const execute: ScheduleExecutor = async (job) => {
      open += 1;
      if (open > 1) overlap = true;
      log.push(`start ${job.id}`);
      if (job.id === 'due') await gate.promise;
      log.push(`end ${job.id}`);
      open -= 1;
      return { ok: true, summary: job.id, error: null };
    };
    const attached = attachScheduler({ store, characterId: 'alice', execute, now: () => Date.parse('2026-10-13T13:00:30Z') });
    await settle();
    const queued = attached.runNow('later');
    await settle();
    expect(log).toEqual(['start due']);
    gate.resolve();
    expect(await queued).toMatchObject({ summary: 'later' });
    expect(log).toEqual(['start due', 'end due', 'start later', 'end later']);
    expect(overlap).toBe(false);
  });
});

/** Answers by request: records what it was offered and calls each tool once. */
class ToolUser implements LLMProvider {
  readonly id = 'tool-user';
  readonly requests: LlmRequest[] = [];
  async listModels(): Promise<never[]> {
    return [];
  }
  async *stream(request: LlmRequest, _options?: { signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { type: 'tool-call', call: { id: 'c1', name: 'files_read', arguments: {}, source: 'llm', requestedAt: '2026-10-13T13:00:00.000Z' } };
      yield { type: 'tool-call', call: { id: 'c2', name: 'home_lights_off', arguments: {}, source: 'llm', requestedAt: '2026-10-13T13:00:00.000Z' } };
      yield { type: 'finish', reason: 'tool-calls', usage: null };
      return;
    }
    yield { type: 'text-delta', text: '[emote:joy] Three new notes,  all about the trip.' };
    yield { type: 'finish', reason: 'stop', usage: null };
  }
}

function tool(name: string, used: string[]): LocalTool {
  return {
    definition: { name, description: name, parameters: { type: 'object', properties: {} } },
    run: async () => {
      used.push(name);
      return { ok: true };
    },
  };
}

describe('agentExecutor (the agent loop, the allowlist)', () => {
  it('a reminder is its own message: no model is asked', async () => {
    const llm = new ToolUser();
    const outcome = await agentExecutor({ llm, modelId: 'm', character: { name: 'Alice' }, tools: () => [] })(schedule(), new Date());
    expect(outcome).toEqual({ ok: true, summary: 'Call the vet', error: null });
    expect(llm.requests).toHaveLength(0);
  });

  it('offers only the allowed tools, runs only those, and keeps the answer plain', async () => {
    const used: string[] = [];
    const llm = new ToolUser();
    const execute = agentExecutor({ llm, modelId: 'm', character: { name: 'Alice', summary: 'Curious.' }, tools: () => [tool('files_read', used), tool('home_lights_off', used)] });
    const outcome = await execute(schedule({ description: 'Summarise new notes', taskPrompt: 'Read the notes folder and summarise what is new.', allowedTools: ['files_read'] }), at('2026-10-13T13:00:00Z'));
    expect(llm.requests[0]?.tools.map((offered) => offered.name)).toEqual(['files_read']);
    expect(used).toEqual(['files_read']);
    expect(outcome).toEqual({ ok: true, summary: 'Three new notes, all about the trip.', error: null });
    expect(llm.requests[0]?.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining(SCHEDULE_MARKER) as unknown });
  });
});

describe('a simulated week (the done-when)', () => {
  it('replays deterministically', async () => {
    const first = await simulateScheduleWeek();
    const second = await simulateScheduleWeek();
    expect(second.log).toEqual(first.log);
    expect(first.log.length).toBeGreaterThan(150);
  });

  it('holds every schedule to its policy and delivery, across the night the clocks go back', async () => {
    const week = await simulateScheduleWeek();
    const of = (id: string): ScheduleRun[] => week.runs.filter((run) => run.scheduleId === id);
    // Weekdays at 08:00, on time: Thu, Fri, Mon, Tue (failed, told as a failure), Wed.
    expect(of('morning').map((run) => run.outcome)).toEqual(['ok', 'ok', 'ok', 'failed', 'ok']);
    expect(week.said.filter((entry) => entry.scheduleId === 'morning').map((entry) => entry.summary)).toContain('I couldn\'t do "Morning summary": the calendar did not answer');
    // Missed while away on Saturday, run once when the page opened, said then.
    expect(of('plants')).toEqual([expect.objectContaining({ scheduledFor: iso(toronto(10, 31, 10)), startedAt: iso(toronto(10, 31, 23)) })]);
    expect(week.said.find((entry) => entry.scheduleId === 'plants')?.at).toBe(toronto(10, 31, 23));
    // On time, by notification.
    expect(week.notified).toEqual(['Mon Nov 02 09:30 EST Stand-up call at 9:30']);
    // Notifications blocked on Wednesday: said at the next session instead.
    expect(week.said.find((entry) => entry.scheduleId === 'bins')).toBeDefined();
    // run_all: every night's re-index, each once, the Sunday one on time after the change.
    expect(of('reindex').map((run) => run.scheduledFor)).toEqual([
      iso(toronto(10, 29, 3)),
      iso(toronto(10, 30, 3)),
      iso(toronto(10, 31, 3)),
      iso(toronto(11, 1, 3)),
      iso(toronto(11, 2, 3)),
      iso(toronto(11, 3, 3)),
      iso(toronto(11, 4, 3)),
    ]);
    // run_all, capped: never more than the limit at one waking, and no hour twice.
    const feeds = of('feeds');
    const perWake = new Map<string, number>();
    for (const run of feeds) perWake.set(run.startedAt, (perWake.get(run.startedAt) ?? 0) + 1);
    expect(Math.max(...perWake.values())).toBe(RUN_ALL_LIMIT);
    expect(new Set(feeds.map((run) => run.scheduledFor)).size).toBe(feeds.length);
    // skip: ran only on the one night the page was open at 01:30 (the first 01:30, EDT).
    expect(of('night').filter((run) => run.outcome === 'ok').map((run) => run.scheduledFor)).toEqual(['2026-11-01T05:30:00.000Z']);
    expect(of('paused')).toEqual([]);
    // Everything meant for them was told; every result with words is a memory.
    expect(pendingDeliveries(week.schedules)).toEqual([]);
    expect(week.episodes).toBe(week.runs.filter((run) => run.summary !== '').length);
    expect(week.runs.every((run) => Date.parse(run.startedAt) - Date.parse(run.scheduledFor ?? run.startedAt) >= 0)).toBe(true);
  });
});
