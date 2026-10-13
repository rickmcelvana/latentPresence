import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeMemoryStore, Schedules } from '@latentpresence/core';
import type { Schedule } from '@latentpresence/protocol';
import type { NotificationPermissionState, PageNotifications } from '../chat/notifications';
import { SchedulesPanel } from './SchedulesPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CHICAGO = 'America/Chicago';
// Tuesday 2026-10-13 10:00 in Chicago (CDT).
const NOW = new Date('2026-10-13T15:00:00.000Z');

function notifier(state: NotificationPermissionState = 'granted') {
  const calls: string[] = [];
  let current = state;
  const notifications: PageNotifications = {
    permission: () => current,
    request: async () => {
      calls.push('request');
      current = 'granted';
      return 'granted';
    },
    show: () => true,
  };
  return { notifications, calls };
}

async function setup(state: NotificationPermissionState = 'granted') {
  const store = new FakeMemoryStore();
  let ids = 0;
  const schedules = new Schedules({ store, characterId: 'alice', timeZone: CHICAGO, companion: false, now: () => NOW, newId: () => `s${(ids += 1)}` });
  await schedules.load();
  const { notifications, calls } = notifier(state);
  const view = () => render(<SchedulesPanel characterName="Alice" notifications={notifications} now={() => NOW} schedules={schedules} timeZone={CHICAGO} />);
  return { store, schedules, calls, view };
}

async function made(schedules: Schedules, request: Parameters<Schedules['create']>[0]): Promise<Schedule> {
  const outcome = await schedules.create(request);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.schedule;
}

/** The row (list item) a description belongs to. */
function row(description: string): HTMLElement {
  const item = screen.getByText(description).closest('li');
  if (item === null) throw new Error(`no row for ${description}`);
  return item;
}

describe('SchedulesPanel (P6-T08, ADR-58)', () => {
  it('with no schedules object, says schedules are kept with memory and links to Settings', () => {
    render(<SchedulesPanel characterName="Alice" notifications={notifier().notifications} schedules={null} timeZone={CHICAGO} />);
    expect(screen.getByText(/Schedules are kept with memory — memory is off\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Settings/ }).getAttribute('href')).toBe('/settings');
  });

  it('with nothing scheduled, says how to begin', async () => {
    const { view } = await setup();
    view();
    expect(screen.getByText('Nothing scheduled. Ask her: "remind me Thursday at 9 to call the vet".')).toBeTruthy();
    expect(document.querySelector('.schedules-finished')).toBeNull();
  });

  it('lists upcoming by next run, active before paused, each with its next run in words and how it repeats', async () => {
    const { schedules, view } = await setup();
    await made(schedules, { description: 'call the vet', at: '2026-10-15T09:00' });
    await made(schedules, { description: 'stretch', repeat: '30 7 * * 1-5' });
    await made(schedules, { description: 'tea', inMinutes: 20 });
    await made(schedules, { description: 'rent', repeat: '0 9 1 * *' });
    await made(schedules, { description: 'long one', inMinutes: 5 });
    await schedules.pause('long one');
    view();
    const upcoming = within(screen.getByRole('list', { name: 'Upcoming' }));
    expect(upcoming.getAllByRole('listitem').map((item) => item.querySelector('.schedules-title')?.textContent)).toEqual(['tea', 'stretch', 'call the vet', 'rent', 'long one']);
    expect(within(row('call the vet')).getByText('Thursday 15 October at 09:00 (in 1 day and 23 hours)')).toBeTruthy();
    expect(within(row('call the vet')).getByText('once')).toBeTruthy();
    expect(within(row('stretch')).getByText('weekdays at 07:30')).toBeTruthy();
    expect(within(row('stretch')).getByText('tomorrow at 07:30 (in 21 hours and 30 minutes)')).toBeTruthy();
    expect(within(row('tea')).getByText('today at 10:20 (in 20 minutes)')).toBeTruthy();
    expect(within(row('rent')).getByText('0 9 1 * *')).toBeTruthy();
    expect(within(row('long one')).getByText('paused')).toBeTruthy();
  });

  it('says where a reminder runs when it is the companion, and shows the last run with its outcome, summary and time', async () => {
    const store = new FakeMemoryStore();
    const schedules = new Schedules({ store, characterId: 'alice', timeZone: CHICAGO, companion: true, now: () => NOW, newId: () => 'c1' });
    await made(schedules, { description: 'drink water', repeat: '0 * * * *' });
    const [stored] = await store.listSchedules('alice');
    if (stored === undefined) throw new Error('missing');
    await store.saveSchedule({
      ...stored,
      lastRun: { id: 'r', scheduleId: 'c1', startedAt: '2026-10-13T14:00:01.000Z', finishedAt: '2026-10-13T14:00:02.000Z', outcome: 'failed', summary: 'I couldn\'t do "drink water": no tap', error: 'no tap', scheduledFor: null, deliveredAt: null },
    });
    await schedules.load();
    render(<SchedulesPanel characterName="Alice" notifications={notifier().notifications} now={() => NOW} schedules={schedules} timeZone={CHICAGO} />);
    const item = within(row('drink water'));
    expect(item.getByText('runs on the companion')).toBeTruthy();
    expect(item.getByText('0 * * * *')).toBeTruthy();
    const pill = item.getByText('failed');
    expect(pill.className).toContain('pill-danger');
    expect(item.getByText(/I couldn't do "drink water": no tap/)).toBeTruthy();
    expect(item.getByText('at 09:00 this morning')).toBeTruthy();
  });

  it('pauses and resumes: the row says paused, and Resume starts it again from now', async () => {
    const { schedules, view } = await setup();
    await made(schedules, { description: 'stretch', repeat: '0 9 * * *' });
    view();
    fireEvent.click(within(row('stretch')).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(within(row('stretch')).getByText('paused')).toBeTruthy());
    expect(schedules.find('stretch')?.status).toBe('paused');
    expect(within(row('stretch')).queryByRole('button', { name: 'Pause' })).toBeNull();
    fireEvent.click(within(row('stretch')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(within(row('stretch')).getByText('tomorrow at 09:00 (in 23 hours)')).toBeTruthy());
    expect(schedules.find('stretch')?.status).toBe('active');
  });

  it('cancel asks in the row first: No backs out, Yes cancels it and folds it away; no window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { schedules, view } = await setup();
    await made(schedules, { description: 'call the vet', at: '2026-10-15T09:00' });
    await made(schedules, { description: 'tea', inMinutes: 20 });
    view();
    fireEvent.click(within(row('call the vet')).getByRole('button', { name: 'Cancel' }));
    expect(within(row('call the vet')).getByText(/Cancel\?/)).toBeTruthy();
    // Only the row asked.
    expect(within(row('tea')).queryByText(/Cancel\?/)).toBeNull();
    expect(schedules.find('call the vet')?.status).toBe('active');
    fireEvent.click(within(row('call the vet')).getByRole('button', { name: 'No' }));
    expect(within(row('call the vet')).queryByText(/Cancel\?/)).toBeNull();
    expect(schedules.find('call the vet')?.status).toBe('active');
    fireEvent.click(within(row('call the vet')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(row('call the vet')).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(schedules.find('call the vet')?.status).toBe('cancelled'));
    const details = document.querySelector('.schedules-finished') as HTMLDetailsElement;
    expect(within(screen.getByRole('list', { name: 'Upcoming' })).queryByText('call the vet')).toBeNull();
    expect(within(details).getByText('call the vet')).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('finished ones are folded below, collapsed, with the same rows and no buttons', async () => {
    const { schedules, view } = await setup();
    await made(schedules, { description: 'old one', inMinutes: 5 });
    await made(schedules, { description: 'new one', inMinutes: 50 });
    await schedules.cancel('old one');
    view();
    const details = document.querySelector('.schedules-finished') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('Finished (1)')).toBeTruthy();
    const finished = within(row('old one'));
    expect(finished.getByText('cancelled')).toBeTruthy();
    expect(finished.queryByRole('button')).toBeNull();
    expect(within(row('new one')).getAllByRole('button').map((button) => button.textContent)).toEqual(['Pause', 'Cancel']);
  });

  it('says why when a press is refused, and a one-shot whose time has passed cannot resume', async () => {
    const { store, schedules, view } = await setup();
    await made(schedules, { description: 'tea', inMinutes: 20 });
    await schedules.pause('tea');
    const [stored] = await store.listSchedules('alice');
    if (stored === undefined) throw new Error('missing');
    await store.saveSchedule({ ...stored, nextRunAt: '2026-10-13T14:00:00.000Z', trigger: { kind: 'once', at: '2026-10-13T14:00:00.000Z' } });
    await schedules.load();
    view();
    fireEvent.click(within(row('tea')).getByRole('button', { name: 'Resume' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/its time has passed — make a new one/);
    expect(schedules.find('tea')?.status).toBe('paused');
  });

  it('shows her changes as they arrive, through the same object her tools use', async () => {
    const { schedules, view } = await setup();
    view();
    expect(screen.getByText(/Nothing scheduled/)).toBeTruthy();
    await made(schedules, { description: 'call the vet', at: '2026-10-15T09:00' });
    await waitFor(() => expect(screen.getByText('call the vet')).toBeTruthy());
  });

  it('notifications, default: a button that asks from the click, then the header goes quiet', async () => {
    const { calls, view } = await setup('default');
    view();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Let her notify you' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Let her notify you' })).toBeNull());
    expect(calls).toEqual(['request']);
  });

  it('notifications, denied: only a hint; unsupported and granted: nothing', async () => {
    const denied = await setup('denied');
    const first = denied.view();
    expect(screen.getByText('Notifications are blocked for this site in your browser.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Let her notify you' })).toBeNull();
    first.unmount();
    for (const state of ['unsupported', 'granted'] as const) {
      const quiet = await setup(state);
      const view = quiet.view();
      expect(screen.queryByRole('button', { name: 'Let her notify you' })).toBeNull();
      expect(screen.queryByText(/Notifications are blocked/)).toBeNull();
      expect(document.querySelector('.schedules-notify')).toBeNull();
      view.unmount();
    }
  });
});
