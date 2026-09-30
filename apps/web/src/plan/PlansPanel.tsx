import { useCallback, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { planFileName, planSubject, planToMarkdown, type FollowUp, type Plans, type PlansSnapshot } from '@latentpresence/core';
import type { PlanDocument, PlanPhase, PlanTask } from '@latentpresence/protocol';

/**
 * The Plans panel (P4-T07, ADR-41): the person's side of the plans she makes with `plan_create`
 * and `plan_update`. The list shows every plan; opening one shows an editor over a local draft
 * and points her at it (`setFocus`). Everything reads and writes through `Plans` — the same
 * object her tools use — so her changes arrive here through its snapshot and a save goes
 * through the same queue as hers.
 *
 * **The draft is never overwritten while the person is typing into it.** A change from her
 * replaces a clean draft silently; over a dirty one it shows a notice with "Load hers".
 */
export interface PlansPanelProps {
  /** Null while memory is off or not ready: plans are kept with memory. */
  readonly plans: Plans | null;
  readonly characterName: string;
}

type PlanStatus = PlanDocument['status'];
type TaskStatus = PlanTask['status'];

const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'active', 'done', 'archived'];
const TASK_STATUSES: readonly { readonly value: TaskStatus; readonly label: string }[] = [
  { value: 'todo', label: 'to do' },
  { value: 'doing', label: 'doing' },
  { value: 'done', label: 'done' },
  { value: 'dropped', label: 'dropped' },
];
const STATUS_PILL: Readonly<Record<PlanStatus, string>> = { draft: '', active: 'pill-accent', done: 'pill-ok', archived: '' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "3 of 9 done", not counting what was dropped; a plan with nothing to do yet says so. */
function progressOf(plan: PlanDocument): string {
  const tasks = plan.phases.flatMap((phase) => phase.tasks).filter((task) => task.status !== 'dropped');
  if (tasks.length === 0) return 'no tasks yet';
  return `${tasks.filter((task) => task.status === 'done').length} of ${tasks.length} done`;
}

/** `2026-10-15` → `15 Oct`. Read off the string, so no time zone can move the day. */
function followUpDay(on: string): string {
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})$/u.exec(on) ?? [];
  const name = MONTHS[Number(month) - 1];
  return name === undefined ? on : `${Number(day)} ${name}`;
}

function isSameDraft(a: PlanDocument, b: PlanDocument): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasBlankTitle(plan: PlanDocument): boolean {
  return plan.phases.some((phase) => phase.title.trim() === '' || phase.tasks.some((task) => task.title.trim() === ''));
}

/** The draft as it is saved: titles trimmed, nothing else touched. */
function tidy(plan: PlanDocument): PlanDocument {
  return { ...plan, phases: plan.phases.map((phase) => ({ ...phase, title: phase.title.trim(), tasks: phase.tasks.map((task) => ({ ...task, title: task.title.trim() })) })) };
}

function download(plan: PlanDocument): void {
  const url = URL.createObjectURL(new Blob([planToMarkdown(plan)], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = planFileName(plan);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function PlansPanel({ plans, characterName }: PlansPanelProps): ReactElement {
  if (plans === null) {
    return (
      <section className="panel plans-panel">
        <div className="panel-header">
          <span className="panel-title">Plans</span>
        </div>
        <p className="plans-off">
          Plans are kept with memory, and memory is off. <a href="/settings">Settings → Memory</a> turns it on.
        </p>
      </section>
    );
  }
  return <PlansView characterName={characterName} plans={plans} />;
}

function PlansView({ plans, characterName }: { plans: Plans; characterName: string }): ReactElement {
  const subscribe = useCallback((listener: () => void) => plans.subscribe(listener), [plans]);
  const getSnapshot = useCallback(() => plans.snapshot(), [plans]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const open = openId === null ? undefined : snapshot.plans.find((plan) => plan.id === openId);

  return (
    <section className="panel plans-panel">
      <div className="panel-header">
        <span className="panel-title">Plans</span>
        {open !== undefined && (
          <button className="btn btn-sm btn-ghost" onClick={() => setOpenId(null)} type="button">
            Back
          </button>
        )}
      </div>
      <div className="plans-body">
        {open === undefined ? (
          <PlanList
            onOpen={(plan) => {
              // The person opening a plan is how they point her at it (ADR-41).
              plans.setFocus(plan.id);
              setOpenId(plan.id);
            }}
            setShowArchived={setShowArchived}
            showArchived={showArchived}
            snapshot={snapshot}
          />
        ) : (
          <PlanEditor characterName={characterName} key={open.id} latest={open} plans={plans} />
        )}
      </div>
    </section>
  );
}

function PlanRow({ plan, focused, followUps, onOpen }: { plan: PlanDocument; focused: boolean; followUps: readonly FollowUp[]; onOpen: (plan: PlanDocument) => void }): ReactElement {
  return (
    <li className="plans-item">
      <button className="plans-row" onClick={() => onOpen(plan)} type="button">
        <span className="plans-row-title">{plan.title}</span>
        <span className="plans-row-meta">
          <span className={`pill ${STATUS_PILL[plan.status]}`}>{plan.status}</span>
          <span>{progressOf(plan)}</span>
          <span>updated {plan.updatedAt.slice(0, 10)}</span>
          {focused && <span className="pill pill-accent">working on it now</span>}
        </span>
      </button>
      {followUps.map((follow) => (
        <p className="plans-follow-up" key={follow.factId}>
          Follow up on {followUpDay(follow.on)}: {follow.about}
        </p>
      ))}
    </li>
  );
}

function PlanList({
  snapshot,
  showArchived,
  setShowArchived,
  onOpen,
}: {
  snapshot: PlansSnapshot;
  showArchived: boolean;
  setShowArchived: (show: boolean) => void;
  onOpen: (plan: PlanDocument) => void;
}): ReactElement {
  const live = snapshot.plans.filter((plan) => plan.status !== 'archived');
  const archived = snapshot.plans.filter((plan) => plan.status === 'archived');
  const rows = showArchived ? [...live, ...archived] : live;
  if (snapshot.plans.length === 0) return <p className="plans-empty">No plans yet. Say “let’s plan…” and she will start one.</p>;
  return (
    <>
      {rows.length === 0 && <p className="plans-empty">Nothing unarchived.</p>}
      <ul className="plans-list">
        {rows.map((plan) => (
          <PlanRow
            focused={snapshot.focusId === plan.id}
            followUps={snapshot.followUps.filter((follow) => follow.subject === planSubject(plan.title))}
            key={plan.id}
            onOpen={onOpen}
            plan={plan}
          />
        ))}
      </ul>
      {archived.length > 0 && (
        <button className="btn btn-sm btn-ghost plans-archived-toggle" onClick={() => setShowArchived(!showArchived)} type="button">
          {showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
        </button>
      )}
    </>
  );
}

interface Conflict {
  readonly current: PlanDocument;
  readonly reason: string;
}

function PlanEditor({ plans, latest, characterName }: { plans: Plans; latest: PlanDocument; characterName: string }): ReactElement {
  // The plan the draft was copied from: its version is what a save is checked against.
  const [origin, setOrigin] = useState(latest);
  const [draft, setDraft] = useState(latest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Tasks whose notes box was opened here, so clearing one does not collapse it under the cursor.
  const [notesOpen, setNotesOpen] = useState<ReadonlySet<string>>(new Set());

  const dirty = !isSameDraft(draft, origin);
  const behind = latest.version !== origin.version;

  // Her change over a clean draft is taken silently. While a save is in flight the snapshot
  // moves on to our own write, which the save's result will adopt. (State set during render,
  // React's way of following a prop: it re-renders at once with `behind` false.)
  if (behind && !dirty && !busy) {
    setOrigin(latest);
    setDraft(latest);
  }

  const adopt = (plan: PlanDocument): void => {
    setOrigin(plan);
    setDraft(plan);
    setConflict(null);
    setError(null);
  };

  const save = async (basedOn: number): Promise<void> => {
    if (hasBlankTitle(draft)) {
      setError('Every phase and task needs a title.');
      return;
    }
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const outcome = await plans.save(tidy(draft), basedOn);
      if (outcome.ok) adopt(outcome.plan);
      else if (outcome.current !== null && outcome.current.version !== basedOn) setConflict({ current: outcome.current, reason: outcome.reason });
      else setError(outcome.reason);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const copy = (): void => {
    navigator.clipboard.writeText(planToMarkdown(latest)).then(
      () => setCopied('Copied'),
      (failure: unknown) => setCopied(messageOf(failure)),
    );
  };

  const setPhases = (change: (phases: readonly PlanPhase[]) => PlanPhase[]): void => setDraft((current) => ({ ...current, phases: change(current.phases) }));
  const setPhase = (id: string, change: (phase: PlanPhase) => PlanPhase): void => setPhases((phases) => phases.map((phase) => (phase.id === id ? change(phase) : phase)));
  const setTask = (phaseId: string, taskId: string, change: (task: PlanTask) => PlanTask): void =>
    setPhase(phaseId, (phase) => ({ ...phase, tasks: phase.tasks.map((task) => (task.id === taskId ? change(task) : task)) }));

  return (
    <div className="plans-editor">
      {conflict !== null ? (
        <div className="plans-notice" role="alert">
          <span>{conflict.reason}</span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void save(conflict.current.version)} type="button">
            Keep mine
          </button>
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => adopt(conflict.current)} type="button">
            Load hers
          </button>
        </div>
      ) : (
        behind &&
        dirty &&
        !busy && (
          <div className="plans-notice" role="status">
            <span>{characterName} changed this plan while you were editing it.</span>
            <button className="btn btn-sm btn-ghost" onClick={() => adopt(latest)} type="button">
              Load hers
            </button>
          </div>
        )
      )}

      <label className="field">
        <span className="field-label">Title</span>
        <input className="input" onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} value={draft.title} />
      </label>
      <label className="field">
        <span className="field-label">Goal</span>
        <textarea className="textarea" onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))} value={draft.goal} />
      </label>
      <label className="field">
        <span className="field-label">Status</span>
        <select className="select" onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as PlanStatus }))} value={draft.status}>
          {PLAN_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>

      {draft.phases.map((phase, p) => (
        <section className="plans-phase" key={phase.id}>
          <div className="plans-phase-head">
            <input aria-label={`Phase ${p + 1} title`} className="input" onChange={(event) => setPhase(phase.id, (current) => ({ ...current, title: event.target.value }))} value={phase.title} />
            <button aria-label={`Remove phase ${p + 1}`} className="btn btn-sm btn-ghost" onClick={() => setPhases((phases) => phases.filter((other) => other.id !== phase.id))} type="button">
              Remove
            </button>
          </div>
          {phase.tasks.map((task, t) => {
            const name = `Phase ${p + 1} task ${t + 1}`;
            const notesShown = task.notes !== '' || notesOpen.has(task.id);
            return (
              <div className="plans-task" key={task.id}>
                <div className="plans-task-head">
                  <input aria-label={`${name} title`} className="input" onChange={(event) => setTask(phase.id, task.id, (current) => ({ ...current, title: event.target.value }))} value={task.title} />
                  <select
                    aria-label={`${name} status`}
                    className="select plans-task-status"
                    onChange={(event) => setTask(phase.id, task.id, (current) => ({ ...current, status: event.target.value as TaskStatus }))}
                    value={task.status}
                  >
                    {TASK_STATUSES.map((status) => (
                      <option key={status.value} value={status.value}>
                        {status.label}
                      </option>
                    ))}
                  </select>
                  {!notesShown && (
                    <button aria-label={`Add notes to ${name}`} className="btn btn-sm btn-ghost" onClick={() => setNotesOpen((current) => new Set(current).add(task.id))} type="button">
                      Notes
                    </button>
                  )}
                  <button
                    aria-label={`Remove ${name}`}
                    className="btn btn-sm btn-ghost"
                    onClick={() => setPhase(phase.id, (current) => ({ ...current, tasks: current.tasks.filter((other) => other.id !== task.id) }))}
                    title="Remove this task"
                    type="button"
                  >
                    ✕
                  </button>
                </div>
                {notesShown && (
                  <textarea
                    aria-label={`${name} notes`}
                    className="textarea plans-notes"
                    onChange={(event) => {
                      setNotesOpen((current) => new Set(current).add(task.id));
                      setTask(phase.id, task.id, (current) => ({ ...current, notes: event.target.value }));
                    }}
                    value={task.notes}
                  />
                )}
              </div>
            );
          })}
          <button
            aria-label={`Add task to phase ${p + 1}`}
            className="btn btn-sm btn-ghost plans-add"
            onClick={() => setPhase(phase.id, (current) => ({ ...current, tasks: [...current.tasks, { id: crypto.randomUUID(), title: '', status: 'todo', notes: '' }] }))}
            type="button"
          >
            Add task
          </button>
        </section>
      ))}
      <button className="btn btn-sm btn-ghost plans-add" onClick={() => setPhases((phases) => [...phases, { id: crypto.randomUUID(), title: '', tasks: [] }])} type="button">
        Add phase
      </button>

      {error !== null && <p className="plans-error">{error}</p>}

      <div className="plans-actions">
        <button className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => void save(origin.version)} type="button">
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-sm btn-ghost" disabled={!dirty || busy} onClick={() => adopt(origin)} type="button">
          Revert
        </button>
        <button className="btn btn-sm" onClick={() => download(latest)} type="button">
          Download .md
        </button>
        <button className="btn btn-sm" onClick={copy} type="button">
          Copy Markdown
        </button>
        {copied !== null && (
          <span className="field-hint" role="status">
            {copied}
          </span>
        )}
      </div>
    </div>
  );
}
