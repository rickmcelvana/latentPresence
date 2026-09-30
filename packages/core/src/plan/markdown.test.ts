import type { PlanDocument } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { planFileName, planToMarkdown } from './markdown';

const plan: PlanDocument = {
  id: 'p1',
  characterId: 'alice',
  title: 'Vegetable garden',
  goal: 'Easy vegetables by spring.',
  status: 'active',
  version: 4,
  updatedAt: '2026-09-30T12:00:00.000Z',
  phases: [
    {
      id: 'ph1',
      title: 'Prepare the bed',
      tasks: [
        { id: 't1', title: 'Pick a sunny spot', status: 'done', notes: 'Behind the shed.' },
        { id: 't2', title: 'Dig in compost', status: 'doing', notes: 'Two bags\nfrom the allotment' },
        { id: 't3', title: 'Raised bed', status: 'dropped', notes: '' },
      ],
    },
    { id: 'ph2', title: 'Plant', tasks: [] },
  ],
};

describe('planToMarkdown (P4-T07, ADR-41)', () => {
  it('renders a stable document', () => {
    expect(planToMarkdown(plan)).toMatchSnapshot();
  });

  it('ticks done tasks, strikes dropped ones and keeps notes under their task', () => {
    const text = planToMarkdown(plan);
    expect(text).toContain('- [x] Pick a sunny spot\n  Behind the shed.');
    expect(text).toContain('- [ ] Dig in compost (under way)\n  Two bags\n  from the allotment');
    expect(text).toContain('- [ ] ~~Raised bed~~ (dropped)');
    expect(text).toContain('## Plant\n\n_No tasks yet._');
  });

  it('leaves out an empty goal', () => {
    expect(planToMarkdown({ ...plan, goal: ' ' })).toMatch(/^# Vegetable garden\n\nStatus: active/u);
  });

  it('names the file after the plan', () => {
    expect(planFileName(plan)).toBe('vegetable-garden.md');
    expect(planFileName({ ...plan, title: '???' })).toBe('plan.md');
  });
});
