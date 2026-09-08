import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * When a schedule fires. A cron expression carries its own time zone because the user
 * moves and the browser does not always agree with the server (ADR-14).
 */
export const ScheduleTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    expression: z.string().min(1),
    /** IANA zone name, for example `America/Toronto`. */
    timeZone: z.string().min(1),
  }),
  z.object({
    kind: z.literal('once'),
    at: TimestampSchema,
  }),
]);
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

/** How the result reaches the user. Nothing is created silently (ADR-14). */
export const DeliveryModeSchema = z.enum(['speak_next_session', 'notify', 'silent_log']);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

/**
 * What to do about runs missed while nothing was awake. A nightly re-index wants
 * `run_once`; a reminder that has passed wants `skip`.
 */
export const CatchUpPolicySchema = z.enum(['skip', 'run_once', 'run_all']);
export type CatchUpPolicy = z.infer<typeof CatchUpPolicySchema>;

export const ScheduleStatusSchema = z.enum(['active', 'paused', 'completed', 'failed', 'cancelled']);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

/**
 * Where the job runs. `core` needs the tab or the tray app awake because it needs the
 * LLM; `companion` is for tool-only jobs that must run with the app closed.
 */
export const ScheduleRunnerSchema = z.enum(['core', 'companion']);
export type ScheduleRunner = z.infer<typeof ScheduleRunnerSchema>;

/** A job the user asked the character to do later or repeatedly (ADR-14). */
export const ScheduleSchema = z.object({
  id: IdSchema,
  characterId: IdSchema,
  /** What the user would call it. Shown in the Schedules panel and said back aloud. */
  description: z.string().min(1).max(200),
  trigger: ScheduleTriggerSchema,
  /** The prompt the job runs with, if it runs through the LLM. */
  taskPrompt: z.string(),
  /** Tool names this job may use. Empty means no tools. */
  allowedTools: z.array(z.string().min(1)),
  delivery: DeliveryModeSchema,
  catchUp: CatchUpPolicySchema,
  runOn: ScheduleRunnerSchema,
  status: ScheduleStatusSchema,
  lastRunAt: TimestampSchema.nullable(),
  nextRunAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/** The outcome of one firing, kept so the character can say what happened and when. */
export const ScheduleRunSchema = z.object({
  id: IdSchema,
  scheduleId: IdSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  outcome: z.enum(['ok', 'failed', 'skipped']),
  /** What to tell the user, already phrased. Empty for a silent log. */
  summary: z.string(),
  error: z.string().nullable(),
});
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;
