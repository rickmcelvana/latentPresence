import { describe, expect, it } from 'vitest';
import { ScheduleRunSchema, ScheduleSchema, ScheduleTriggerSchema } from './schedule';

const schedule = {
  id: 'sched-1',
  characterId: 'alice',
  description: 'Summarise the notes folder every weekday at 8',
  trigger: { kind: 'cron', expression: '0 8 * * 1-5', timeZone: 'America/Toronto' },
  taskPrompt: 'Read the notes folder and tell me what changed.',
  allowedTools: ['search_documents'],
  delivery: 'speak_next_session',
  catchUp: 'run_once',
  runOn: 'core',
  status: 'active',
  lastRunAt: null,
  nextRunAt: '2026-09-09T12:00:00Z',
  createdAt: '2026-09-08T10:00:00Z',
};

describe('ScheduleTriggerSchema', () => {
  it('demands a time zone on a cron trigger', () => {
    // "Every weekday at 8" means nothing without a zone, and the browser's zone is not
    // the server's. Missing it would fire the job at the wrong hour, silently.
    const out = ScheduleTriggerSchema.safeParse({ kind: 'cron', expression: '0 8 * * 1-5' });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['timeZone']);
  });

  it('takes a one-shot trigger as an absolute instant', () => {
    expect(ScheduleTriggerSchema.parse({ kind: 'once', at: '2026-09-11T13:00:00Z' })).toEqual({
      kind: 'once',
      at: '2026-09-11T13:00:00Z',
    });
    expect(ScheduleTriggerSchema.safeParse({ kind: 'once', at: 'thursday' }).success).toBe(false);
  });
});

describe('ScheduleSchema', () => {
  it('round-trips a job the user asked for aloud', () => {
    expect(ScheduleSchema.parse(schedule)).toEqual(schedule);
  });

  it('will not accept a job with no delivery decision', () => {
    // Every schedule has to say how its result reaches the user; "unset" would mean a
    // job that runs and is never heard from (ADR-14).
    const { delivery: _dropped, ...withoutDelivery } = schedule;
    expect(ScheduleSchema.safeParse(withoutDelivery).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...schedule, delivery: 'email' }).success).toBe(false);
  });

  it('requires a description a person can recognise in the panel', () => {
    expect(ScheduleSchema.safeParse({ ...schedule, description: '' }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...schedule, description: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('distinguishes never-run from run-and-forgotten', () => {
    // lastRunAt is nullable, not optional: a missing field would let a store that
    // forgot to write it look like a job that has never fired.
    expect(ScheduleSchema.parse({ ...schedule, lastRunAt: null }).lastRunAt).toBeNull();
    const { lastRunAt: _dropped, ...withoutLastRun } = schedule;
    expect(ScheduleSchema.safeParse(withoutLastRun).success).toBe(false);
  });
});

describe('ScheduleRunSchema', () => {
  it('records an outcome for every firing, including the ones that failed', () => {
    const run = {
      id: 'run-1',
      scheduleId: 'sched-1',
      startedAt: '2026-09-09T12:00:00Z',
      finishedAt: '2026-09-09T12:00:04Z',
      outcome: 'failed',
      summary: '',
      error: 'companion unreachable',
    };
    expect(ScheduleRunSchema.parse(run)).toEqual(run);
    expect(ScheduleRunSchema.safeParse({ ...run, outcome: 'maybe' }).success).toBe(false);
  });
});
