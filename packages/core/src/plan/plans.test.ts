import type { PlanDocument } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { MemoryStoreError } from '../memory/errors';
import { FakeMemoryStore } from '../memory/fake-store';
import { MemoryKernel } from '../memory/kernel';
import { FOLLOW_UP_PREDICATE, MAX_PROMPT_PLANS, Plans, followUpOf, planSubject } from './plans';

const NOW = new Date('2026-09-30T12:00:00.000Z');

function setup(options: { readonly withMemory?: boolean } = {}) {
  const store = new FakeMemoryStore({ now: () => NOW });
  const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: null, now: () => NOW });
  let next = 0;
  const plans = new Plans({ store, characterId: 'alice', followUps: options.withMemory === false ? null : kernel, now: () => NOW, newId: () => `id${(next += 1)}` });
  return { store, kernel, plans };
}

async function created(plans: Plans): Promise<PlanDocument> {
  const outcome = await plans.create({
    title: 'Vegetable garden',
    goal: 'Easy vegetables by spring.',
    phases: [
      { title: 'Prepare the bed', tasks: ['Pick a sunny spot', 'Dig in compost'] },
      { title: 'Plant', tasks: ['Buy seedlings'] },
    ],
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.plan;
}

describe('Plans — her tools', () => {
  it('creates a plan at version 1 in the store, in focus, and tells the panel', async () => {
    const { store, plans } = setup();
    const seen: number[] = [];
    plans.subscribe(() => seen.push(plans.snapshot().plans.length));
    const plan = await created(plans);
    expect(plan).toMatchObject({ characterId: 'alice', title: 'Vegetable garden', status: 'active', version: 1 });
    expect(plan.phases.map((phase) => [phase.title, phase.tasks.map((task) => [task.title, task.status])])).toEqual([
      ['Prepare the bed', [['Pick a sunny spot', 'todo'], ['Dig in compost', 'todo']]],
      ['Plant', [['Buy seedlings', 'todo']]],
    ]);
    expect(await store.listPlans('alice')).toEqual([plan]);
    expect(plans.snapshot()).toMatchObject({ focusId: plan.id, plans: [plan] });
    expect(seen.at(-1)).toBe(1);
  });

  it('refuses a second plan with the same title, pointing at the first', async () => {
    const { plans } = setup();
    const plan = await created(plans);
    const again = await plans.create({ title: 'vegetable garden.' });
    expect(again).toEqual({ ok: false, reason: expect.stringContaining(plan.id) });
  });

  it('marks a task done by its title, keeping every id and everything else as it was', async () => {
    const { store, plans } = setup();
    const plan = await created(plans);
    const outcome = await plans.revise('Vegetable garden', { taskUpdates: [{ task: 'dig in compost', status: 'done', notes: 'Two bags' }] });
    expect(outcome.ok).toBe(true);
    const [stored] = await store.listPlans('alice');
    expect(stored?.version).toBe(2);
    expect(stored?.phases).toEqual(plan.phases.map((phase) => ({ ...phase, tasks: phase.tasks.map((task) => (task.title === 'Dig in compost' ? { ...task, status: 'done', notes: 'Two bags' } : task)) })));
  });

  it('replaces the outline by titles: kept tasks keep their id and progress, new ones start to do', async () => {
    const { plans } = setup();
    const plan = await created(plans);
    await plans.revise(plan.id, { taskUpdates: [{ task: 'Pick a sunny spot', status: 'done' }] });
    const outcome = await plans.revise(plan.id, {
      phases: [
        { title: 'prepare the bed', tasks: ['Pick a sunny spot', 'Build a raised bed'] },
        { title: 'Plant', tasks: ['Buy seedlings', { title: 'Water daily', status: 'doing' }] },
      ],
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    const [prepare, plant] = outcome.plan.phases;
    expect(prepare?.id).toBe(plan.phases[0]?.id);
    expect(prepare?.title).toBe('prepare the bed');
    expect(prepare?.tasks[0]).toEqual({ ...plan.phases[0]?.tasks[0], status: 'done' });
    expect(prepare?.tasks[1]).toMatchObject({ title: 'Build a raised bed', status: 'todo' });
    expect(plant?.tasks.map((task) => [task.title, task.status])).toEqual([['Buy seedlings', 'todo'], ['Water daily', 'doing']]);
    expect(prepare?.tasks.some((task) => task.title === 'Dig in compost')).toBe(false);
  });

  it('refuses, with something she can act on, an unknown plan or task — and saves nothing', async () => {
    const { store, plans } = setup();
    await created(plans);
    expect(await plans.revise('Herb spiral', { goal: 'x' })).toEqual({ ok: false, reason: expect.stringContaining('Vegetable garden (id id1)') });
    expect(await plans.revise('Vegetable garden', { goal: 'changed', taskUpdates: [{ task: 'Mow the lawn', status: 'done' }] })).toEqual({
      ok: false,
      reason: expect.stringContaining('Pick a sunny spot; Dig in compost; Buy seedlings'),
    });
    expect((await store.listPlans('alice'))[0]).toMatchObject({ version: 1, goal: 'Easy vegetables by spring.' });
  });

  it('lets go of the focus when the plan is done', async () => {
    const { plans } = setup();
    const plan = await created(plans);
    await plans.revise(plan.id, { status: 'done' });
    expect(plans.snapshot().focusId).toBeNull();
    expect(plans.promptContext().focusId).toBeNull();
  });
});

describe('Plans — the panel', () => {
  it('saves the whole plan against the version it opened', async () => {
    const { store, plans } = setup();
    const plan = await created(plans);
    const outcome = await plans.save({ ...plan, goal: 'Salad by May.' }, 1);
    expect(outcome).toMatchObject({ ok: true, plan: { version: 2, goal: 'Salad by May.' } });
    expect((await store.listPlans('alice'))[0]?.version).toBe(2);
  });

  it('is told when she changed the plan meanwhile, and "keep mine" saves over hers', async () => {
    const { plans } = setup();
    const opened = await created(plans);
    await plans.revise(opened.id, { taskUpdates: [{ task: 'Buy seedlings', status: 'done' }] });
    const refused = await plans.save({ ...opened, goal: 'Mine.' }, opened.version);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.current?.version).toBe(2);
    const kept = await plans.save({ ...opened, goal: 'Mine.' }, refused.current?.version ?? 0);
    expect(kept).toMatchObject({ ok: true, plan: { version: 3, goal: 'Mine.' } });
  });

  it('reloads, and says so, when another tab saved first', async () => {
    const { store, plans } = setup();
    const plan = await created(plans);
    await store.savePlan({ ...plan, version: 2, title: 'Veg patch' });
    const outcome = await plans.revise(plan.id, { goal: 'x' });
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('changed somewhere else') });
    expect(plans.snapshot().plans[0]).toMatchObject({ version: 2, title: 'Veg patch' });
  });

  it('waits its turn behind her write, so neither loses the other', async () => {
    const { store, plans } = setup();
    const plan = await created(plans);
    const hers = plans.revise(plan.id, { taskUpdates: [{ task: 'Buy seedlings', status: 'done' }] });
    const mine = plans.save({ ...plan, goal: 'Mine.' }, 1);
    expect((await hers).ok).toBe(true);
    expect((await mine).ok).toBe(false);
    expect((await store.listPlans('alice'))[0]?.version).toBe(2);
  });

  it('puts the plan the person opens in focus', async () => {
    const { plans } = setup();
    const first = await created(plans);
    await plans.create({ title: 'Tidy the shed' });
    plans.setFocus(first.id);
    expect(plans.promptContext().focusId).toBe(first.id);
  });

  it('bounds the prompt to the newest plans, never dropping the one in focus, and leaves archived out', async () => {
    const { plans } = setup();
    const first = await created(plans);
    for (let i = 0; i < MAX_PROMPT_PLANS; i += 1) await plans.create({ title: `Plan ${i}` });
    await plans.create({ title: 'Old', status: 'archived' });
    plans.setFocus(first.id);
    const context = plans.promptContext();
    expect(context.plans).toHaveLength(MAX_PROMPT_PLANS + 1);
    expect(context.plans.map((plan) => plan.title)).toContain('Vegetable garden');
    expect(context.plans.map((plan) => plan.title)).not.toContain('Old');
  });
});

describe('Plans — follow-ups are facts (ADR-41)', () => {
  it('writes one through memory, readable as a fact, and in the prompt', async () => {
    const { store, kernel, plans } = setup();
    const plan = await created(plans);
    expect(await plans.followUp(plan.title, '2026-10-15', 'whether the seedlings are in')).toMatchObject({ ok: true });
    const facts = await store.currentFacts('alice');
    expect(facts).toEqual([expect.objectContaining({ subject: 'vegetable_garden', predicate: FOLLOW_UP_PREDICATE, object: '2026-10-15: whether the seedlings are in', confidence: 1 })]);
    expect((await kernel.knownFacts()).map((fact) => fact.id)).toEqual([facts[0]?.id]);
    expect(plans.promptContext().followUps).toEqual([{ plan: 'vegetable garden', on: '2026-10-15', about: 'whether the seedlings are in' }]);
  });

  it('keeps several per plan: the same day replaces, cancelling drops one day or all, and finishing the plan drops the rest', async () => {
    const { store, plans } = setup();
    const plan = await created(plans);
    const current = async (): Promise<string[]> => (await store.currentFacts('alice')).map((fact) => fact.object).toSorted();
    await plans.followUp(plan.id, '2026-10-05', 'how the clearing went');
    await plans.followUp(plan.id, '2026-10-14', 'the soil');
    await plans.followUp(plan.id, '2026-10-14', 'the soil, and the compost');
    expect(await current()).toEqual(['2026-10-05: how the clearing went', '2026-10-14: the soil, and the compost']);
    expect(await plans.cancelFollowUps(plan.id, '2026-10-05')).toMatchObject({ ok: true });
    expect(await current()).toEqual(['2026-10-14: the soil, and the compost']);
    expect(await plans.cancelFollowUps(plan.id, '2026-10-05')).toEqual({ ok: false, reason: expect.stringContaining('no follow-up on 2026-10-05') });
    await plans.followUp(plan.id, '2026-10-25', 'harvest');
    await plans.cancelFollowUps(plan.id, null);
    expect(await current()).toEqual([]);
    await plans.followUp(plan.id, '2026-10-25', 'harvest');
    await plans.revise(plan.id, { status: 'done' });
    expect(await current()).toEqual([]);
    expect(plans.promptContext().followUps).toEqual([]);
    expect(store.rows.facts).toHaveLength(5);
  });

  it('reads the follow-ups back on the next visit', async () => {
    const { store, kernel, plans } = setup();
    const plan = await created(plans);
    await plans.followUp(plan.id, '2026-10-15', 'seedlings');
    const later = new Plans({ store, characterId: 'alice', followUps: new MemoryKernel({ store, characterId: 'alice', extractor: null, now: () => NOW }), now: () => NOW });
    await later.load();
    expect(later.snapshot().followUps).toEqual([expect.objectContaining({ subject: 'vegetable_garden', on: '2026-10-15', about: 'seedlings' })]);
    expect(kernel.characterId).toBe('alice');
  });

  it('refuses a day it cannot read, and a follow-up with memory off', async () => {
    const { plans } = setup();
    const plan = await created(plans);
    expect(await plans.followUp(plan.id, 'next Tuesday', 'x')).toEqual({ ok: false, reason: expect.stringContaining('YYYY-MM-DD') });
    expect(await plans.followUp(plan.id, '2026-13-01', 'x')).toMatchObject({ ok: false });
    const off = setup({ withMemory: false }).plans;
    const offPlan = await created(off);
    expect(await off.followUp(offPlan.id, '2026-10-15', 'x')).toEqual({ ok: false, reason: expect.stringContaining('memory is off') });
  });

  it('reads a follow-up fact and ignores every other', () => {
    const base = { id: 'f', characterId: 'alice', subject: 'vegetable_garden', predicate: FOLLOW_UP_PREDICATE, object: '2026-10-15: seedlings', confidence: 1, validFrom: NOW.toISOString(), validTo: null, recordedAt: NOW.toISOString(), sourceEpisodeId: null, embedding: null };
    expect(followUpOf(base)).toEqual({ factId: 'f', subject: 'vegetable_garden', on: '2026-10-15', about: 'seedlings' });
    expect(followUpOf({ ...base, predicate: 'lives_in' })).toBeNull();
    expect(followUpOf({ ...base, object: 'soon' })).toBeNull();
    expect(planSubject('  Vegetable garden!  ')).toBe('vegetable_garden');
    expect(planSubject('???')).toBe('plan');
  });
});

describe('Plans — store failures', () => {
  it('passes on a failure that is not a conflict', async () => {
    const { store, plans } = setup();
    store.savePlan = async () => {
      throw new MemoryStoreError('unavailable', 'no database');
    };
    await expect(plans.create({ title: 'x' })).rejects.toThrow('no database');
    // The queue carries on after a failure.
    store.savePlan = FakeMemoryStore.prototype.savePlan.bind(store);
    expect((await plans.create({ title: 'y' })).ok).toBe(true);
  });
});
