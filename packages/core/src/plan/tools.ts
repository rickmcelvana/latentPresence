import type { JsonValue, PlanDocument } from '@latentpresence/protocol';
import { z } from 'zod';
import type { LocalTool } from '../self/tools';
import type { PlanOutcome, Plans } from './plans';

/**
 * `plan_create`, `plan_update`, `plan_list` and `plan_follow_up` (P4-T07, ADR-41) — the plan's
 * `plan.create/update/list`, with underscores like her note tools, run by `withLocalTools`.
 *
 * **She edits by title, never by id**: a model that must quote task ids back gets them wrong,
 * one that names "dig in compost" does not. A plan may be named by id or title. Tasks go in as
 * plain strings; a task's status or notes change with `task_updates`, so marking one done
 * never means resending the outline.
 */

const Status = z.enum(['todo', 'doing', 'done', 'dropped']);
const PlanStatus = z.enum(['draft', 'active', 'done', 'archived']);
/**
 * An array a model sent as a JSON string — glm-5.2:cloud's first `plan_create` did exactly
 * that (live, 2026-09-30). Read it rather than refuse it: the intent is not in doubt.
 */
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

/** What was wrong with a call, in a line she can fix it from. */
function problem(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'the call'}: ${issue.message}`).join('; ');
}

const Task = z.union([z.string(), z.object({ title: z.string(), status: Status.optional(), notes: z.string().optional() })]);
const Phase = z.object({ title: z.string(), tasks: z.array(Task).optional() });

const CreateArgs = z.object({ title: z.string(), goal: z.string().optional(), status: PlanStatus.optional(), phases: stringified(z.array(Phase)).optional() });
const UpdateArgs = z.object({
  plan: z.string(),
  title: z.string().optional(),
  goal: z.string().optional(),
  status: PlanStatus.optional(),
  phases: stringified(z.array(Phase)).optional(),
  task_updates: stringified(z.array(z.object({ task: z.string(), status: Status.optional(), notes: z.string().optional() }))).optional(),
});
const ListArgs = z.object({ include_archived: z.boolean().optional() });
const FollowUpArgs = z.object({ plan: z.string(), on: z.string().optional(), about: z.string().optional(), cancel: z.boolean().optional() });

const PHASES_SCHEMA: JsonValue = {
  type: 'array',
  description: 'The steps of the plan in order, each with its tasks.',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short name for this step, like "Prepare the bed".' },
      tasks: { type: 'array', items: { type: 'string' }, description: 'The tasks in this step, each a short phrase.' },
    },
    required: ['title'],
  },
};

/** What she reads back: enough to go on, not the whole document again. */
function summary(plan: PlanDocument): JsonValue {
  return {
    id: plan.id,
    title: plan.title,
    goal: plan.goal,
    status: plan.status,
    phases: plan.phases.map((phase) => ({ title: phase.title, tasks: phase.tasks.map((task) => (task.status === 'todo' ? task.title : `${task.title} (${task.status})`)) })),
  };
}

function reply(outcome: PlanOutcome): JsonValue {
  return outcome.ok ? { saved: summary(outcome.plan) } : { error: outcome.reason };
}

export function planTools(plans: Plans): LocalTool[] {
  return [
    {
      definition: {
        name: 'plan_create',
        description:
          'Save a new plan you are making with the person, once it has a shape — a goal and a few steps. It appears in their side panel. ' +
          'Keep it up to date afterwards with plan_update rather than creating another.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What the plan is for, in a few words, like "Vegetable garden".' },
            goal: { type: 'string', description: 'One sentence: what done looks like.' },
            phases: PHASES_SCHEMA,
          },
          required: ['title'],
        },
      },
      async run(args) {
        const parsed = CreateArgs.safeParse(args);
        if (!parsed.success) return { error: `Not saved — ${problem(parsed.error)}. Give a title, and optionally a goal and phases: an array of { title, tasks: [strings] }.` };
        return reply(await plans.create(parsed.data));
      },
    },
    {
      definition: {
        name: 'plan_update',
        description:
          'Change a plan: give only what changed. "phases" replaces the whole outline (tasks you keep keep their progress). ' +
          'To mark a task done, or add a note to it, use "task_updates" with the task as it is written.',
        parameters: {
          type: 'object',
          properties: {
            plan: { type: 'string', description: 'The plan’s id, or its title.' },
            title: { type: 'string' },
            goal: { type: 'string' },
            status: { type: 'string', enum: [...PlanStatus.options], description: 'active while you are working on it; done when it is achieved; archived to put it away.' },
            phases: PHASES_SCHEMA,
            task_updates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  task: { type: 'string', description: 'The task, as it is written in the plan.' },
                  status: { type: 'string', enum: [...Status.options] },
                  notes: { type: 'string', description: 'A note on the task, replacing any before.' },
                },
                required: ['task'],
              },
            },
          },
          required: ['plan'],
        },
      },
      async run(args) {
        const parsed = UpdateArgs.safeParse(args);
        if (!parsed.success) return { error: `Not saved — ${problem(parsed.error)}. Name the plan, then give what changed: title, goal, status, phases or task_updates.` };
        const { plan, task_updates: taskUpdates, ...change } = parsed.data;
        if (Object.keys(change).length === 0 && taskUpdates === undefined) return { error: 'Say what changed: title, goal, status, phases or task_updates.' };
        return reply(await plans.revise(plan, { ...change, ...(taskUpdates === undefined ? {} : { taskUpdates }) }));
      },
    },
    {
      definition: {
        name: 'plan_list',
        description: 'List your plans with the person, with their steps and progress.',
        parameters: { type: 'object', properties: { include_archived: { type: 'boolean', description: 'Also list the plans put away.' } } },
      },
      async run(args) {
        const parsed = ListArgs.safeParse(args);
        await plans.load();
        const all = plans.snapshot().plans;
        const shown = parsed.success && parsed.data.include_archived === true ? all : all.filter((plan) => plan.status !== 'archived');
        return { plans: shown.map(summary) };
      },
    },
    {
      definition: {
        name: 'plan_follow_up',
        description:
          'When you agree to check in on a plan later, set the day. You will be reminded in your instructions, and should bring it up yourself the next time you talk on or after that day. ' +
          'A plan can have several; one on the same day replaces it. Once you have asked about one that was due, cancel it.',
        parameters: {
          type: 'object',
          properties: {
            plan: { type: 'string', description: 'The plan’s id, or its title.' },
            on: { type: 'string', description: 'When: a day as YYYY-MM-DD, or a time as YYYY-MM-DD HH:MM in their own clock — use a time for "in a few hours". Work it out from the time it is now.' },
            about: { type: 'string', description: 'What to ask about, like "whether the seedlings are in".' },
            cancel: { type: 'boolean', description: 'True to drop the follow-up on that day instead, or every one for the plan when no day is given.' },
          },
          required: ['plan'],
        },
      },
      async run(args) {
        const parsed = FollowUpArgs.safeParse(args);
        if (!parsed.success) return { error: 'Name the plan, the day (YYYY-MM-DD) and what to ask about.' };
        const { plan, on, about, cancel } = parsed.data;
        if (cancel !== true && on === undefined) return { error: 'Give the day as YYYY-MM-DD (or a time as YYYY-MM-DD HH:MM), or cancel: true.' };
        const outcome = cancel === true ? await plans.cancelFollowUps(plan, on ?? null) : await plans.followUp(plan, on ?? '', about ?? '');
        if (!outcome.ok) return { error: outcome.reason };
        return cancel === true ? { cancelled: { plan: outcome.plan.title, on: on ?? 'every day' } } : { follow_up: { plan: outcome.plan.title, on: on ?? '', about: about ?? '' } };
      },
    },
  ];
}
