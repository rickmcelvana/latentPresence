import type { JsonValue, Schedule, ScheduleRun } from '@latentpresence/protocol';
import { z } from 'zod';
import type { LocalTool } from '../self/tools';
import { nextFiring } from './cron';
import type { ScheduleResult, Schedules } from './schedules';
import { dueWords, repeatWords, whenWords } from './words';

/**
 * `schedule_create`, `schedule_list`, `schedule_cancel` and `schedule_run_now` (P6-T08, ADR-58),
 * run by `withLocalTools` like her note and plan tools: zod-parsed arguments, a refusal is a result
 * she can act on and never a throw.
 *
 * **She reads the words; the code reads the clock.** She gives a wall-clock `at` worked out from
 * RIGHT NOW; the reply's `when` is the code's own reading of what was saved, which she is told to
 * say back word for word — so a misread Thursday is caught by the person hearing it, not lost.
 */

/** A model may send an array as a JSON string (glm-5.2:cloud did, for plans): read it rather than refuse it. */
function stringified<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }, schema);
}

/** A count that arrives as the string "30". */
const wholeNumber = z.preprocess((value) => (typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : value), z.number());

function problem(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'the call'}: ${issue.message}`).join('; ');
}

const CreateArgs = z.object({
  description: z.string(),
  at: z.string().optional(),
  in_minutes: wholeNumber.optional(),
  repeat: z.string().optional(),
  task: z.string().optional(),
  tools: stringified(z.array(z.string())).optional(),
  delivery: z.enum(['speak_next_session', 'notify', 'silent_log']).optional(),
  catch_up: z.enum(['skip', 'run_once', 'run_all']).optional(),
});
const ListArgs = z.object({ include_finished: z.boolean().optional() });
const RefArgs = z.object({ schedule: z.string() });

export interface ScheduleToolsOptions {
  readonly schedules: Schedules;
  /** The scheduler's `runNow`: null when it cannot be run from here. */
  readonly runNow: (id: string) => Promise<ScheduleRun | null>;
  /** The person's IANA zone, for the words. */
  readonly timeZone: string;
  readonly now?: () => Date;
}

function isLive(schedule: Schedule): boolean {
  return schedule.status === 'active' || schedule.status === 'paused';
}

const repeatsOf = (schedule: Schedule): string | null => (schedule.trigger.kind === 'cron' ? (repeatWords(schedule.trigger.expression) ?? schedule.trigger.expression) : null);

const refused = (outcome: Extract<ScheduleResult, { ok: false }>): JsonValue => ({ error: outcome.reason });

export function scheduleTools(options: ScheduleToolsOptions): LocalTool[] {
  const { schedules, timeZone } = options;
  const now = options.now ?? (() => new Date());

  /** The next run in words, or null once finished (or a paused job's time has gone by). */
  const whenOf = (schedule: Schedule): string | null => {
    if (!isLive(schedule) || schedule.nextRunAt === null) return null;
    const next = new Date(schedule.nextRunAt);
    return schedule.status === 'paused' && next.getTime() <= now().getTime() ? null : whenWords(next, now(), timeZone);
  };
  return [
    {
      definition: {
        name: 'schedule_create',
        description:
          'Set something for a time, to happen even when they are away: use it for "remind me…" or "every morning…". It is saved at once and shows in their Schedules panel. ' +
          'This is different from plan_follow_up, which is something you raise yourself in conversation. ' +
          'Give exactly one of "at", "in_minutes" or "repeat". "at" is the time in THEIR local time as YYYY-MM-DDTHH:MM, worked out from RIGHT NOW in your instructions: "Thursday at 9" is the coming Thursday\'s date at 09:00. ' +
          'AFTER SAVING, TELL THEM WHEN IT WILL HAPPEN USING THE REPLY\'S "when", WORD FOR WORD, NOT YOUR OWN READING OF IT. If it is wrong, cancel it with schedule_cancel and create the right one. ' +
          'Leave out "task" for a plain reminder: the description is what you will say. Give a "task" only for work you will do at that time, with the tools it may use.',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What it is, in a few words, like "call the vet". For a reminder this is what you will say.' },
            at: { type: 'string', description: 'A single time, YYYY-MM-DDTHH:MM, in their own clock, worked out from the time it is now.' },
            in_minutes: { type: 'integer', description: 'Instead of "at": a count of minutes from now, 1 to 10080 (a week).' },
            repeat: { type: 'string', description: 'Instead of "at": a five-field cron line in their own clock, like "0 9 * * *" (every day at 9) or "30 7 * * 1-5" (weekdays at 7:30).' },
            task: { type: 'string', description: 'Only for work to do rather than a reminder: what you will be asked to do at that time. Leave out for a reminder.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'With a task: the names of your tools it may use. Nothing else is offered to it.' },
            delivery: { type: 'string', enum: ['notify', 'speak_next_session', 'silent_log'], description: 'How they hear the result: notify (default; a notification if they are away, else you say it), speak_next_session, or silent_log (only written down).' },
            catch_up: { type: 'string', enum: ['skip', 'run_once', 'run_all'], description: 'What to do about times missed while nothing was open. Default: run_once for a single time, skip for a repeat.' },
          },
          required: ['description'],
        },
      },
      async run(args) {
        const parsed = CreateArgs.safeParse(args);
        if (!parsed.success) return { error: `Not saved — ${problem(parsed.error)}. Give a description and exactly one of at, in_minutes or repeat.` };
        const { in_minutes: inMinutes, catch_up: catchUp, ...rest } = parsed.data;
        const outcome = await schedules.create({ ...rest, inMinutes, catchUp });
        if (!outcome.ok) return refused(outcome);
        const { schedule } = outcome;
        const first = schedule.nextRunAt === null ? nextFiring(schedule.trigger, now()) : new Date(schedule.nextRunAt);
        return {
          saved: { id: schedule.id, description: schedule.description, when: first === null ? null : whenWords(first, now(), timeZone), repeats: repeatsOf(schedule), runs_on: schedule.runOn },
        };
      },
    },
    {
      definition: {
        name: 'schedule_list',
        description: 'List what is scheduled — upcoming reminders and jobs with when each will next happen, and the last result of each. Use it before telling them what is coming up, and to find the one to cancel.',
        parameters: { type: 'object', properties: { include_finished: { type: 'boolean', description: 'Also list the ones that are done, failed or cancelled.' } } },
      },
      async run(args) {
        const parsed = ListArgs.safeParse(args);
        await schedules.load();
        const all = schedules.snapshot();
        const shown = parsed.success && parsed.data.include_finished === true ? all : all.filter(isLive);
        return {
          schedules: shown.map((schedule) => ({
            id: schedule.id,
            description: schedule.description,
            status: schedule.status,
            when: whenOf(schedule),
            repeats: repeatsOf(schedule),
            last:
              schedule.lastRun === null
                ? null
                : { outcome: schedule.lastRun.outcome, summary: schedule.lastRun.summary, at: dueWords(new Date(schedule.lastRun.finishedAt ?? schedule.lastRun.startedAt), now(), timeZone) },
          })),
        };
      },
    },
    {
      definition: {
        name: 'schedule_cancel',
        description: 'Cancel a reminder or job so it does not happen. It is kept in their list as cancelled. Name it by its description or id (schedule_list shows both).',
        parameters: { type: 'object', properties: { schedule: { type: 'string', description: 'The schedule’s id, or its description.' } }, required: ['schedule'] },
      },
      async run(args) {
        const parsed = RefArgs.safeParse(args);
        if (!parsed.success) return { error: 'Name the schedule to cancel: its description or id.' };
        const outcome = await schedules.cancel(parsed.data.schedule);
        return outcome.ok ? { cancelled: { id: outcome.schedule.id, description: outcome.schedule.description } } : refused(outcome);
      },
    },
    {
      definition: {
        name: 'schedule_run_now',
        description: 'Do a scheduled job right now, once, without changing when it next happens. You get the result back: tell them it yourself. Name it by its description or id.',
        parameters: { type: 'object', properties: { schedule: { type: 'string', description: 'The schedule’s id, or its description.' } }, required: ['schedule'] },
      },
      async run(args) {
        const parsed = RefArgs.safeParse(args);
        if (!parsed.success) return { error: 'Name the schedule to run: its description or id.' };
        await schedules.load();
        const found = schedules.find(parsed.data.schedule);
        if (found === null) {
          const live = schedules.snapshot().filter(isLive);
          return { error: `There is no schedule "${parsed.data.schedule}". ${live.length === 0 ? 'Nothing is scheduled.' : `The schedules are: ${live.map((schedule) => `${schedule.description} (id ${schedule.id})`).join('; ')}.`}` };
        }
        const run = await options.runNow(found.id);
        if (run === null) {
          return { error: found.toolCall === null ? `"${found.description}" could not be run from here.` : `"${found.description}" is a job the companion runs; it cannot be run from here.` };
        }
        return { ran: { outcome: run.outcome, summary: run.summary } };
      },
    },
  ];
}
