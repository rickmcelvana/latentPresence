import type { PlanDocument, PlanTask } from '@latentpresence/protocol';

/**
 * A plan as Markdown (P4-T07, ADR-41): what the panel downloads or copies. `#` title, the
 * goal, `##` per phase, a checklist per task — done ticked, under way said, dropped struck
 * through — and a task's notes indented beneath it so they stay with it in any renderer.
 */

const STATUS = { draft: 'draft', active: 'active', done: 'done', archived: 'archived' } as const;

function taskLine(task: PlanTask): string {
  const box = task.status === 'done' ? '[x]' : '[ ]';
  const title = task.status === 'dropped' ? `~~${task.title}~~ (dropped)` : task.status === 'doing' ? `${task.title} (under way)` : task.title;
  const notes = task.notes.trim() === '' ? [] : task.notes.trim().split(/\r?\n/u).map((line) => `  ${line}`);
  return [`- ${box} ${title}`, ...notes].join('\n');
}

export function planToMarkdown(plan: PlanDocument): string {
  const blocks = [`# ${plan.title}`];
  if (plan.goal.trim() !== '') blocks.push(plan.goal.trim());
  blocks.push(`Status: ${STATUS[plan.status]} · updated ${plan.updatedAt.slice(0, 10)}`);
  for (const phase of plan.phases) {
    blocks.push(`## ${phase.title}`);
    blocks.push(phase.tasks.length === 0 ? '_No tasks yet._' : phase.tasks.map(taskLine).join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

/** A file name for the download: "Vegetable garden" → `vegetable-garden.md`. */
export function planFileName(plan: PlanDocument): string {
  const slug = plan.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 60);
  return `${slug === '' ? 'plan' : slug}.md`;
}
