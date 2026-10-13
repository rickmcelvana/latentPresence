import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { dueWords, repeatWords, whenWords, type Schedules } from '@latentpresence/core';
import type { Schedule } from '@latentpresence/protocol';
import type { NotificationPermissionState, PageNotifications } from '../chat/notifications';

/**
 * The Schedules panel (P6-T08, ADR-58 decision 7): the person's side of what she sets with
 * `schedule_create`. Upcoming first — what it is, the next run in words, whether it repeats, where
 * it runs, and the last result — with Pause/Resume and Cancel; finished and cancelled ones are
 * folded below. Everything reads and writes through `Schedules`, the object her tools use, so her
 * changes arrive here through its snapshot and a press goes through the same queue as hers.
 *
 * **Cancel asks twice, in the row** (a second press: "Cancel? Yes / No"), never `window.confirm`.
 * The header offers the browser's notifications when they could be turned on, from a click — the
 * only place permission is ever asked.
 */
export interface SchedulesPanelProps {
  /** Null while memory is off or not ready: schedules are kept with memory. */
  readonly schedules: Schedules | null;
  readonly characterName: string;
  readonly timeZone: string;
  readonly notifications: PageNotifications;
  /** Test seam: the clock the words are measured from. */
  readonly now?: (() => Date) | undefined;
}

/** The words refresh this often, so "in 3 hours" does not go stale on a panel left open. */
const REFRESH_MS = 30_000;

const OUTCOME_PILL: Readonly<Record<'ok' | 'failed' | 'skipped', string>> = { ok: 'pill-ok', failed: 'pill-danger', skipped: '' };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SchedulesPanel({ schedules, characterName, timeZone, notifications, now }: SchedulesPanelProps): ReactElement {
  if (schedules === null) {
    return (
      <section className="panel schedules-panel">
        <div className="panel-header">
          <span className="panel-title">Schedules</span>
        </div>
        <p className="schedules-off">
          Schedules are kept with memory — memory is off. <a href="/settings">Settings → Memory</a> turns it on.
        </p>
      </section>
    );
  }
  return <SchedulesView characterName={characterName} notifications={notifications} now={now} schedules={schedules} timeZone={timeZone} />;
}

function SchedulesView({ schedules, characterName, timeZone, notifications, now }: SchedulesPanelProps & { schedules: Schedules }): ReactElement {
  const subscribe = useCallback((listener: () => void) => schedules.subscribe(listener), [schedules]);
  const getSnapshot = useCallback(() => schedules.snapshot(), [schedules]);
  const all = useSyncExternalStore(subscribe, getSnapshot);
  const [, setTick] = useState(0);
  const [permission, setPermission] = useState<NotificationPermissionState>(() => notifications.permission());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The panel is the freshest reader there is: read what the scheduler and the companion did since.
  useEffect(() => {
    void schedules.load().catch(() => undefined);
  }, [schedules]);
  useEffect(() => {
    if (now !== undefined) return undefined;
    const timer = globalThis.setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => globalThis.clearInterval(timer);
  }, [now]);

  const clock = (now ?? (() => new Date()))();
  const upcoming = all.filter((schedule) => schedule.status === 'active' || schedule.status === 'paused');
  const finished = all.filter((schedule) => schedule.status !== 'active' && schedule.status !== 'paused');

  const act = (job: Promise<{ readonly ok: boolean; readonly reason?: string }>): void => {
    setProblem(null);
    setConfirming(null);
    job.then(
      (outcome) => {
        if (!outcome.ok) setProblem(outcome.reason ?? 'That did not work.');
      },
      (error: unknown) => setProblem(messageOf(error)),
    );
  };

  const askPermission = (): void => {
    void notifications.request().then(setPermission);
  };

  return (
    <section aria-label={`${characterName}’s schedules`} className="panel schedules-panel">
      <div className="panel-header">
        <span className="panel-title">Schedules</span>
      </div>
      <div className="schedules-body">
        {permission === 'default' && (
          <div className="schedules-notify">
            <button className="btn btn-sm" onClick={askPermission} type="button">
              Let her notify you
            </button>
            <span className="schedules-hint">When this page is hidden, a reminder can come as a notification instead of waiting for you.</span>
          </div>
        )}
        {permission === 'denied' && <p className="schedules-hint">Notifications are blocked for this site in your browser.</p>}
        {problem !== null && (
          <p className="schedules-error" role="alert">
            {problem}
          </p>
        )}
        {all.length === 0 ? (
          <p className="schedules-empty">{'Nothing scheduled. Ask her: "remind me Thursday at 9 to call the vet".'}</p>
        ) : (
          <>
            {upcoming.length === 0 ? (
              <p className="schedules-empty">Nothing coming up.</p>
            ) : (
              <ul aria-label="Upcoming" className="schedules-list">
                {upcoming.map((schedule) => (
                  <ScheduleRow
                    clock={clock}
                    confirming={confirming === schedule.id}
                    key={schedule.id}
                    onCancel={() => act(schedules.cancel(schedule.id))}
                    onConfirm={(on) => setConfirming(on ? schedule.id : null)}
                    onPause={() => act(schedules.pause(schedule.id))}
                    onResume={() => act(schedules.resume(schedule.id))}
                    schedule={schedule}
                    timeZone={timeZone}
                  />
                ))}
              </ul>
            )}
            {finished.length > 0 && (
              <details className="schedules-finished">
                <summary>Finished ({finished.length})</summary>
                <ul aria-label="Finished" className="schedules-list">
                  {finished.map((schedule) => (
                    <ScheduleRow clock={clock} key={schedule.id} schedule={schedule} timeZone={timeZone} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}

interface RowProps {
  readonly schedule: Schedule;
  readonly clock: Date;
  readonly timeZone: string;
  /** Present only on an upcoming row: the buttons. */
  readonly confirming?: boolean;
  readonly onConfirm?: (on: boolean) => void;
  readonly onCancel?: () => void;
  readonly onPause?: () => void;
  readonly onResume?: () => void;
}

/** The next run, or what it is instead of one. */
function nextWords(schedule: Schedule, clock: Date, timeZone: string): string {
  if (schedule.status === 'paused') return 'paused';
  if (schedule.status === 'active' && schedule.nextRunAt !== null) return whenWords(new Date(schedule.nextRunAt), clock, timeZone);
  return schedule.status;
}

function repeatLabel(schedule: Schedule): string {
  return schedule.trigger.kind === 'cron' ? (repeatWords(schedule.trigger.expression) ?? schedule.trigger.expression) : 'once';
}

function ScheduleRow({ schedule, clock, timeZone, confirming, onConfirm, onCancel, onPause, onResume }: RowProps): ReactElement {
  const last = schedule.lastRun;
  // Not a pill: "Thursday 15 October at 09:00 (in 2 days and 1 hour)" must wrap in a narrow drawer.
  const nextClass = schedule.status === 'paused' ? 'schedules-next schedules-next-paused' : 'schedules-next';
  const buttons = onConfirm !== undefined && onCancel !== undefined && onPause !== undefined && onResume !== undefined;
  return (
    <li className="schedules-item">
      <span className="schedules-title">{schedule.description}</span>
      <span className="schedules-meta">
        <span className={nextClass}>{nextWords(schedule, clock, timeZone)}</span>
        <span>{repeatLabel(schedule)}</span>
        {schedule.runOn === 'companion' && <span>runs on the companion</span>}
      </span>
      {last !== null && last.outcome !== 'skipped' && (
        <p className="schedules-last">
          <span className={`pill ${OUTCOME_PILL[last.outcome]}`}>{last.outcome}</span> {last.summary} <span className="schedules-when">{dueWords(new Date(last.finishedAt ?? last.startedAt), clock, timeZone)}</span>
        </p>
      )}
      {last !== null && last.outcome === 'skipped' && (
        <p className="schedules-last">
          <span className="pill">skipped</span> <span className="schedules-when">a firing missed while nothing was open</span>
        </p>
      )}
      {buttons && (
        <div className="schedules-actions">
          {schedule.status === 'paused' ? (
            <button className="btn btn-sm" onClick={onResume} type="button">
              Resume
            </button>
          ) : (
            <button className="btn btn-sm" onClick={onPause} type="button">
              Pause
            </button>
          )}
          {confirming === true ? (
            <span className="schedules-confirm">
              Cancel?{' '}
              <button className="btn btn-sm btn-danger" onClick={onCancel} type="button">
                Yes
              </button>{' '}
              <button className="btn btn-sm btn-ghost" onClick={() => onConfirm(false)} type="button">
                No
              </button>
            </span>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={() => onConfirm(true)} type="button">
              Cancel
            </button>
          )}
        </div>
      )}
    </li>
  );
}
