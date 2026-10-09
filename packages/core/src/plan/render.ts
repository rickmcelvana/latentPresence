import type { PlanDocument, PlanTask } from '@latentpresence/protocol';
import type { PromptPlans } from './plans';

/**
 * The planning section of her prompt (P4-T07, ADR-41). **Brainstorming is these lines, not a
 * mode**: they are there whenever the plan tools are, and what changes while a plan is being
 * made is that it is shown in full. Every other plan is a line; follow-ups say when they are due.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const TASK_STATUS: Record<PlanTask['status'], string> = { todo: 'to do', doing: 'under way', done: 'done', dropped: 'dropped' };

/** `2026-10-15` → "15 October 2026", `2026-10-15 15:00` → "15 October 2026 at 15:00": read straight off the string. */
function sayDate(on: string): string {
  const [year, month, day] = on.slice(0, 10).split('-').map(Number);
  const time = on.length > 10 ? ` at ${on.slice(11, 16)}` : '';
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}${time}`;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `now` where the page is, as `YYYY-MM-DD HH:MM`. A follow-up is due once its `on` sorts at or
 * before it: a day is due all of that day ("2026-10-09" < "2026-10-09 08:00"), a time from then on.
 */
function nowKey(now: Date): string {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

function progress(plan: PlanDocument): string {
  const tasks = plan.phases.flatMap((phase) => phase.tasks).filter((task) => task.status !== 'dropped');
  if (tasks.length === 0) return 'no tasks yet';
  return `${tasks.filter((task) => task.status === 'done').length} of ${tasks.length} tasks done`;
}

function inFull(plan: PlanDocument): string[] {
  return [
    `  ${plan.title} (id ${plan.id}, ${plan.status}).${plan.goal.trim() === '' ? '' : ` Goal: ${plan.goal.trim()}`}`,
    ...(plan.phases.length === 0
      ? ['  No steps yet.']
      : plan.phases.map((phase) => `  ${phase.title}: ${phase.tasks.length === 0 ? 'no tasks yet' : phase.tasks.map((task) => `${task.title} (${TASK_STATUS[task.status]})`).join('; ')}`)),
  ];
}

export function renderPlans(context: PromptPlans, now: Date): string[] {
  const focus = context.plans.find((plan) => plan.id === context.focusId) ?? null;
  const others = context.plans.filter((plan) => plan !== focus);
  const day = nowKey(now);
  return [
    'PLANNING TOGETHER',
    '- When they want to plan something, brainstorm with them first: ask what matters to them,',
    '  and offer an idea or two at a time rather than everything at once.',
    '- The plan tools, and when each is due — call it in that same answer:',
    '  they agree on a plan: plan_create (once; never a second plan for the same thing);',
    '  a step is decided, done or changed: plan_update;',
    '  you agree to check in on it later: plan_follow_up, with the day.',
    '- Saying "I will note that" or "I will check in" without the call does nothing: you will',
    '  not remember it. If you say it, call it.',
    '- The plan is in their side panel. Never read it out or walk them through it: say in a',
    '  sentence that it is saved, then talk about the one step you are deciding next.',
    ...(others.length === 0 ? [] : ['- Your plans with them:', ...others.map((plan) => `  ${plan.title} (id ${plan.id}, ${plan.status}): ${progress(plan)}.`)]),
    ...(focus === null ? [] : ['- The plan you are working on now, as it stands:', ...inFull(focus)]),
    ...(context.followUps.length === 0
      ? []
      : [
          '- Follow-ups you offered. Bring one up yourself when it is due, the way a friend would, then cancel it:',
          ...context.followUps.map((follow) => `  ${follow.plan}, on ${sayDate(follow.on)}: ${follow.about}${follow.on <= day ? ' (due now)' : ''}.`),
        ]),
    '',
  ];
}
