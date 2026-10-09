import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMemoryStore, MemoryKernel, Plans, planToMarkdown } from '@latentpresence/core';
import type { PlanDocument } from '@latentpresence/protocol';
import { PlansPanel } from './PlansPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A real `Plans` over a real store, with a clock that moves a day per call so "newest first"
 * means something, and follow-ups through a real kernel — the brief's "no mocks of the API". */
async function setup() {
  const store = new FakeMemoryStore();
  const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: null });
  let day = 0;
  let next = 0;
  const plans = new Plans({
    store,
    characterId: 'alice',
    followUps: kernel,
    now: () => new Date(Date.UTC(2026, 8, 1 + (day += 1))),
    newId: () => `id${(next += 1)}`,
  });
  await plans.load();
  return { store, plans };
}

async function made(plans: Plans, input: Parameters<Plans['create']>[0]): Promise<PlanDocument> {
  const outcome = await plans.create(input);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.plan;
}

const GARDEN = {
  title: 'Vegetable garden',
  goal: 'Easy vegetables by spring.',
  phases: [
    { title: 'Prepare the bed', tasks: [{ title: 'Pick a sunny spot', status: 'done' as const }, 'Dig in compost', { title: 'Build a fence', status: 'dropped' as const }] },
    { title: 'Plant', tasks: ['Buy seedlings'] },
  ],
};

function open(title: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }));
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}

describe('PlansPanel (P4-T07)', () => {
  it('with no plans object, says plans are kept with memory and links to Settings', () => {
    render(<PlansPanel characterName="Alice" plans={null} />);
    expect(screen.getByText(/Plans are kept with memory/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Settings/ }).getAttribute('href')).toBe('/settings');
  });

  it('starts with an empty state that says how to begin', async () => {
    const { plans } = await setup();
    render(<PlansPanel characterName="Alice" plans={plans} />);
    expect(screen.getByText(/No plans yet\. Say/)).toBeTruthy();
  });

  it('lists plans newest first with progress (dropped tasks not counted) and marks the one in focus; archived wait behind a toggle', async () => {
    const { plans } = await setup();
    await made(plans, { title: 'Old idea', status: 'archived' });
    await made(plans, GARDEN);
    await made(plans, { title: 'Learn to bake', phases: [{ title: 'Basics', tasks: ['Bread'] }] });
    plans.setFocus(plans.find('Vegetable garden')?.id ?? null);
    render(<PlansPanel characterName="Alice" plans={plans} />);

    const rows = screen.getAllByRole('button', { name: /updated/ });
    expect(rows.map((row) => within(row).getByText(/^(Learn|Vegetable)/).textContent)).toEqual(['Learn to bake', 'Vegetable garden']);
    expect(within(rows[1] as HTMLElement).getByText('1 of 3 done', { exact: false })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('working on it now')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByText('working on it now')).toBeNull();
    expect(screen.queryByText('Old idea')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show archived (1)' }));
    expect(screen.getByText('Old idea')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide archived' }));
    expect(screen.queryByText('Old idea')).toBeNull();
  });

  it('shows a follow-up under the plan it names', async () => {
    const { plans } = await setup();
    await made(plans, GARDEN);
    await made(plans, { title: 'Learn to bake' });
    await plans.followUp('Vegetable garden', '2026-10-15', 'ask how the seedlings are doing');
    render(<PlansPanel characterName="Alice" plans={plans} />);

    const garden = screen.getByText('Follow up on 15 Oct: ask how the seedlings are doing').closest('li');
    expect(garden?.textContent).toContain('Vegetable garden');
    expect(screen.getAllByText(/Follow up on/)).toHaveLength(1);
  });

  it('shows a follow-up time when it has one (R-27)', async () => {
    const { plans } = await setup();
    await made(plans, GARDEN);
    await plans.followUp('Vegetable garden', '2026-10-15 18:00', 'whether the pots are bought');
    render(<PlansPanel characterName="Alice" plans={plans} />);
    expect(screen.getByText('Follow up on 15 Oct, 18:00: whether the pots are bought')).toBeTruthy();
  });

  it('opening a plan points her at it, and Back returns to the list with the focus kept', async () => {
    const { plans } = await setup();
    const garden = await made(plans, GARDEN);
    await made(plans, { title: 'Learn to bake' });
    expect(plans.snapshot().focusId).not.toBe(garden.id);
    render(<PlansPanel characterName="Alice" plans={plans} />);

    open('Vegetable garden');
    expect(plans.snapshot().focusId).toBe(garden.id);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Vegetable garden');
    expect((screen.getByLabelText('Phase 1 task 2 title') as HTMLInputElement).value).toBe('Dig in compost');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: /Learn to bake/ })).toBeTruthy();
    expect(plans.snapshot().focusId).toBe(garden.id);
  });

  it('Save is off until something changes; saving writes version + 1 to the store', async () => {
    const { store, plans } = await setup();
    await made(plans, GARDEN);
    render(<PlansPanel characterName="Alice" plans={plans} />);
    open('Vegetable garden');

    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    type('Title', 'Kitchen garden');
    type('Goal', 'Tomatoes by June.');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } });
    fireEvent.change(screen.getByLabelText('Phase 1 task 2 status'), { target: { value: 'doing' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(async () => expect((await store.listPlans('alice'))[0]?.version).toBe(2));
    const [saved] = await store.listPlans('alice');
    expect(saved).toMatchObject({ title: 'Kitchen garden', goal: 'Tomatoes by June.', status: 'draft' });
    expect(saved?.phases[0]?.tasks[1]?.status).toBe('doing');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Kitchen garden');
  });

  it('Revert throws the draft away', async () => {
    const { plans } = await setup();
    await made(plans, GARDEN);
    render(<PlansPanel characterName="Alice" plans={plans} />);
    open('Vegetable garden');
    type('Title', 'Something else');
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Vegetable garden');
  });

  it('adds and removes phases and tasks, and a task’s notes sit behind a toggle until they have text', async () => {
    const { store, plans } = await setup();
    await made(plans, { title: 'Trip', phases: [{ title: 'Book', tasks: ['Flights'] }] });
    render(<PlansPanel characterName="Alice" plans={plans} />);
    open('Trip');

    expect(screen.queryByLabelText('Phase 1 task 1 notes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add notes to Phase 1 task 1' }));
    type('Phase 1 task 1 notes', 'Aisle seat');
    fireEvent.click(screen.getByRole('button', { name: 'Add task to phase 1' }));
    type('Phase 1 task 2 title', 'Hotel');
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    type('Phase 2 title', 'Pack');
    fireEvent.click(screen.getByRole('button', { name: 'Add task to phase 2' }));
    type('Phase 2 task 1 title', 'Passport');
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    type('Phase 3 title', 'Scrapped');
    fireEvent.click(screen.getByRole('button', { name: 'Remove phase 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add task to phase 2' }));
    type('Phase 2 task 2 title', 'Charger');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Phase 2 task 2' }));
    expect(screen.queryByLabelText('Phase 3 title')).toBeNull();
    expect(screen.queryByLabelText('Phase 2 task 2 title')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await store.listPlans('alice'))[0]?.version).toBe(2));
    const [saved] = await store.listPlans('alice');
    expect(saved?.phases.map((phase) => [phase.title, phase.tasks.map((task) => [task.title, task.notes])])).toEqual([
      ['Book', [['Flights', 'Aisle seat'], ['Hotel', '']]],
      ['Pack', [['Passport', '']]],
    ]);
  });

  it('will not save a phase or task with no title, and says so without losing the draft', async () => {
    const { store, plans } = await setup();
    await made(plans, GARDEN);
    render(<PlansPanel characterName="Alice" plans={plans} />);
    open('Vegetable garden');
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Every phase and task needs a title.')).toBeTruthy();
    expect(screen.getByLabelText('Phase 3 title')).toBeTruthy();
    expect((await store.listPlans('alice'))[0]?.version).toBe(1);
  });

  it('takes her change silently while the draft is clean', async () => {
    const { plans } = await setup();
    await made(plans, GARDEN);
    render(<PlansPanel characterName="Alice" plans={plans} />);
    open('Vegetable garden');

    await act(async () => {
      await plans.revise('Vegetable garden', { taskUpdates: [{ task: 'Dig in compost', status: 'done' }] });
    });
    await waitFor(() => expect((screen.getByLabelText('Phase 1 task 2 status') as HTMLSelectElement).value).toBe('done'));
    expect(screen.queryByText(/changed this plan/)).toBeNull();
  });

  it('while the draft is dirty, tells the person she changed it and leaves what they typed; Load hers takes hers', async () => {
    const { plans } = await setup();
    await made(plans, GARDEN);
    render(<PlansPanel characterName="Alice" plans={plans} />);
    open('Vegetable garden');
    type('Goal', 'My own goal');

    await act(async () => {
      await plans.revise('Vegetable garden', { title: 'Veg patch' });
    });
    expect(await screen.findByText('Alice changed this plan while you were editing it.')).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Vegetable garden');
    expect((screen.getByLabelText('Goal') as HTMLTextAreaElement).value).toBe('My own goal');

    fireEvent.click(screen.getByRole('button', { name: 'Load hers' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Veg patch');
    expect((screen.getByLabelText('Goal') as HTMLTextAreaElement).value).toBe('Easy vegetables by spring.');
    expect(screen.queryByText(/changed this plan/)).toBeNull();
  });

  it('a save after she changed the plan is refused with the reason; Keep mine saves over hers', async () => {
    const { store, plans } = await setup();
    await made(plans, GARDEN);
    render(<PlansPanel characterName="Alice" plans={plans} />);
    open('Vegetable garden');
    type('Goal', 'My own goal');
    await act(async () => {
      await plans.revise('Vegetable garden', { title: 'Veg patch' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('She changed this plan while you were editing it.');
    expect((await store.listPlans('alice'))[0]?.title).toBe('Veg patch');
    expect((screen.getByLabelText('Goal') as HTMLTextAreaElement).value).toBe('My own goal');

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(async () => expect((await store.listPlans('alice'))[0]?.version).toBe(3));
    const [saved] = await store.listPlans('alice');
    expect(saved).toMatchObject({ goal: 'My own goal', title: 'Vegetable garden' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refused save’s Load hers throws the draft away and opens hers', async () => {
    const { store, plans } = await setup();
    await made(plans, GARDEN);
    render(<PlansPanel characterName="Alice" plans={plans} />);
    open('Vegetable garden');
    type('Goal', 'My own goal');
    await act(async () => {
      await plans.revise('Vegetable garden', { title: 'Veg patch' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Load hers' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Veg patch');
    expect((screen.getByLabelText('Goal') as HTMLTextAreaElement).value).toBe('Easy vegetables by spring.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((await store.listPlans('alice'))[0]?.version).toBe(2);
  });

  describe('export', () => {
    let blobs: Blob[];
    let downloads: string[];
    beforeEach(() => {
      blobs = [];
      downloads = [];
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob);
          return 'blob:plan';
        },
        revokeObjectURL: () => undefined,
      });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
        downloads.push(`${this.download} ${this.href}`);
      });
    });

    it('Download .md gives the saved plan, not the draft, under its file name', async () => {
      const { plans } = await setup();
      const garden = await made(plans, GARDEN);
      render(<PlansPanel characterName="Alice" plans={plans} />);
      open('Vegetable garden');
      type('Title', 'Unsaved title');
      fireEvent.click(screen.getByRole('button', { name: 'Download .md' }));

      expect(downloads).toEqual(['vegetable-garden.md blob:plan']);
      expect(await textOf(blobs[0] as Blob)).toBe(planToMarkdown(garden));
    });

    it('Copy Markdown writes the saved plan to the clipboard and says Copied; a refusal is shown instead', async () => {
      const { plans } = await setup();
      const garden = await made(plans, GARDEN);
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      render(<PlansPanel characterName="Alice" plans={plans} />);
      open('Vegetable garden');
      fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
      await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
      expect(writeText).toHaveBeenCalledWith(planToMarkdown(garden));

      writeText.mockRejectedValueOnce(new Error('Clipboard blocked'));
      fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
      await waitFor(() => expect(screen.getByText('Clipboard blocked')).toBeTruthy());
    });
  });
});
