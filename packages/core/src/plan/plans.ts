import type { MemoryStore, PlanDocument, PlanPhase, PlanTask, PromptContext, SemanticFact } from '@latentpresence/protocol';
import { MemoryStoreError } from '../memory/errors';

/**
 * The page's plans (P4-T07, ADR-41): what she makes with `plan_create`/`plan_update` and the
 * person edits in the panel, held like `SelfNotes` holds her notes — loaded once, kept in step
 * by its own writes, read synchronously by the prompt and subscribed to by the panel.
 *
 * **One queue for every write.** Hers and the panel's go through it in order, so the two
 * cannot race inside a page; a store `conflict` (another tab) reloads the plans and is
 * reported rather than retried over.
 *
 * **The plan in focus** is the one being worked on — the one she last created or changed, or
 * the one the person opened — and the prompt shows it in full. It lasts the visit and ends
 * when that plan is marked done or archived.
 *
 * **Follow-ups are facts** (ADR-41): subject the plan's title in snake_case, predicate
 * `follow_up_on`, object `YYYY-MM-DD: what to ask about`, written through the memory kernel so
 * they sit in the person's store and in the Memory panel. One per plan.
 */

export const FOLLOW_UP_PREDICATE = 'follow_up_on';
/** Plans in the prompt, one line each, newest first — the one in focus is always among them. */
export const MAX_PROMPT_PLANS = 6;

/** What the plans need from memory for follow-ups; the `MemoryKernel` is one. */
export interface FollowUpFacts {
  knownFacts(): Promise<SemanticFact[]>;
  recordFact(fact: SemanticFact): Promise<void>;
  closeFact(id: string): Promise<void>;
}

export interface FollowUp {
  readonly factId: string;
  /** The fact's subject, the plan's title as it was when the follow-up was set. */
  readonly subject: string;
  /** `YYYY-MM-DD`, or `YYYY-MM-DD HH:MM` in the person's own clock. */
  readonly on: string;
  readonly about: string;
}

export type TaskStatus = PlanTask['status'];
export type PlanStatus = PlanDocument['status'];

export interface TaskInput {
  readonly title: string;
  readonly status?: TaskStatus | undefined;
  readonly notes?: string | undefined;
}

export interface PhaseInput {
  readonly title: string;
  readonly tasks?: readonly (string | TaskInput)[] | undefined;
}

export interface PlanInput {
  readonly title: string;
  readonly goal?: string | undefined;
  readonly status?: PlanStatus | undefined;
  readonly phases?: readonly PhaseInput[] | undefined;
}

/** Her edit, by titles (ADR-41): only what changed; `phases` replaces the outline. */
export interface PlanChange {
  readonly title?: string | undefined;
  readonly goal?: string | undefined;
  readonly status?: PlanStatus | undefined;
  readonly phases?: readonly PhaseInput[] | undefined;
  readonly taskUpdates?: readonly { readonly task: string; readonly status?: TaskStatus | undefined; readonly notes?: string | undefined }[] | undefined;
}

export type PlanOutcome = { readonly ok: true; readonly plan: PlanDocument } | { readonly ok: false; readonly reason: string };
/** The panel's save: refused with the plan as it now stands when someone saved it first. */
export type PlanSaveOutcome = { readonly ok: true; readonly plan: PlanDocument } | { readonly ok: false; readonly current: PlanDocument | null; readonly reason: string };

export interface PlansSnapshot {
  /** Newest first. */
  readonly plans: readonly PlanDocument[];
  readonly focusId: string | null;
  readonly followUps: readonly FollowUp[];
}

export type PromptPlans = NonNullable<PromptContext['plans']>;

/** A plan's name as a fact subject: "Vegetable garden!" → `vegetable_garden`. */
export function planSubject(title: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .slice(0, 60);
  return slug === '' ? 'plan' : slug;
}

/**
 * When to follow up: a day, `YYYY-MM-DD`, or a time on it, `YYYY-MM-DD HH:MM` in the person's
 * own clock — "check in with me in a few hours" is a time, not a day (R-27, 2026-10-09). The
 * model may write a `T` for the space; it is stored with the space, which reads better in the
 * Memory panel.
 */
const FOLLOW_UP_OBJECT = /^(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?):\s*([\s\S]*)$/u;
const WHEN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[T ]([01]\d|2[0-3]):[0-5]\d)?$/u;

/** A follow-up's `on` as stored, or null if it is neither a day nor a time on one. */
export function followUpWhen(on: string): string | null {
  const trimmed = on.trim();
  if (!WHEN.test(trimmed) || Number.isNaN(Date.parse(trimmed.slice(0, 10)))) return null;
  return trimmed.replace('T', ' ');
}

/** A follow-up fact read back, or null for any other fact. */
export function followUpOf(fact: SemanticFact): FollowUp | null {
  if (fact.predicate !== FOLLOW_UP_PREDICATE) return null;
  const match = FOLLOW_UP_OBJECT.exec(fact.object);
  if (match === null) return null;
  return { factId: fact.id, subject: fact.subject, on: match[1] ?? '', about: (match[2] ?? '').trim() };
}

function norm(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/gu, ' ').replace(/[.!?]+$/u, '').trim();
}

/** Titles compared as a person would: case, spacing and trailing punctuation do not count. */
function same(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `plan-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isClosed(status: PlanStatus): boolean {
  return status === 'done' || status === 'archived';
}

export class Plans {
  readonly characterId: string;
  private readonly store: MemoryStore;
  private readonly facts: FollowUpFacts | null;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private plans: PlanDocument[] = [];
  private follows: FollowUp[] = [];
  private focus: string | null = null;
  private current: PlansSnapshot = { plans: [], focusId: null, followUps: [] };
  private readonly listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: {
    readonly store: MemoryStore;
    readonly characterId: string;
    readonly followUps?: FollowUpFacts | null;
    readonly now?: () => Date;
    readonly newId?: () => string;
  }) {
    this.store = options.store;
    this.characterId = options.characterId;
    this.facts = options.followUps ?? null;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  /** Read the plans and follow-ups once; later calls wait on the same read. */
  load(): Promise<void> {
    this.loaded ??= Promise.all([this.store.listPlans(this.characterId), this.facts?.knownFacts() ?? Promise.resolve([])]).then(
      ([plans, facts]) => {
        this.plans = plans;
        this.follows = facts.flatMap((fact) => followUpOf(fact) ?? []);
        this.changed();
      },
      (error: unknown) => {
        // Forget a failed read, so the next use tries again: a companion started after the page
        // opened must not leave plans broken for the rest of the visit (R-27, 2026-10-09).
        this.loaded = null;
        throw error;
      },
    );
    return this.loaded;
  }

  /** Everything the panel shows, replaced (never mutated) on every change. Never waits. */
  snapshot(): PlansSnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A plan by id, or failing that by its title — a model may name either. */
  find(ref: string): PlanDocument | null {
    return this.plans.find((plan) => plan.id === ref) ?? this.plans.find((plan) => same(plan.title, ref)) ?? null;
  }

  /** The person opened a plan in the panel (or closed it, with null): she works on that one. */
  setFocus(id: string | null): void {
    if (this.focus === id) return;
    this.focus = id;
    this.changed();
  }

  /** What the prompt says (ADR-41): the newest unarchived plans, the one in focus in full, the follow-ups. */
  promptContext(): PromptPlans {
    const open = this.plans.filter((plan) => plan.status !== 'archived');
    const shown = open.slice(0, MAX_PROMPT_PLANS);
    const focus = this.focus === null ? null : (this.plans.find((plan) => plan.id === this.focus) ?? null);
    if (focus !== null && !shown.includes(focus)) shown.push(focus);
    return {
      plans: shown,
      focusId: focus?.id ?? null,
      followUps: this.follows.slice(0, 16).map((follow) => ({ plan: follow.subject.replaceAll('_', ' '), on: follow.on, about: follow.about })),
    };
  }

  /** Her `plan_create`. The new plan is the one in focus. */
  create(input: PlanInput): Promise<PlanOutcome> {
    return this.queue(async () => {
      await this.load();
      const title = input.title.trim();
      if (title === '') return { ok: false, reason: 'A plan needs a title.' };
      const existing = this.plans.find((plan) => same(plan.title, title) && plan.status !== 'archived');
      if (existing !== undefined) return { ok: false, reason: `There is already a plan called "${existing.title}" (id ${existing.id}). Change that one with plan_update.` };
      const plan: PlanDocument = {
        id: this.newId(),
        characterId: this.characterId,
        title,
        goal: input.goal?.trim() ?? '',
        phases: this.outline(input.phases ?? [], []),
        status: input.status ?? 'active',
        version: 1,
        updatedAt: this.now().toISOString(),
      };
      return this.write(plan, null);
    });
  }

  /** Her `plan_update`: what changed, by titles. The plan changed is the one in focus. */
  revise(ref: string, change: PlanChange): Promise<PlanOutcome> {
    return this.queue(async () => {
      await this.load();
      const plan = this.find(ref);
      if (plan === null) return { ok: false, reason: this.unknown(ref) };
      const title = change.title?.trim();
      if (title === '') return { ok: false, reason: 'A plan needs a title.' };
      let phases = change.phases === undefined ? plan.phases : this.outline(change.phases, plan.phases);
      for (const update of change.taskUpdates ?? []) {
        const matches = phases.flatMap((phase) => phase.tasks.filter((task) => same(task.title, update.task)));
        if (matches.length === 0) {
          const titles = phases.flatMap((phase) => phase.tasks.map((task) => task.title));
          return { ok: false, reason: `"${plan.title}" has no task called "${update.task}". Its tasks are: ${titles.length === 0 ? 'none yet' : titles.join('; ')}.` };
        }
        phases = phases.map((phase) => ({
          ...phase,
          tasks: phase.tasks.map((task) => (same(task.title, update.task) ? { ...task, status: update.status ?? task.status, notes: update.notes?.trim() ?? task.notes } : task)),
        }));
      }
      const next: PlanDocument = {
        ...plan,
        title: title ?? plan.title,
        goal: change.goal?.trim() ?? plan.goal,
        status: change.status ?? plan.status,
        phases,
        version: plan.version + 1,
        updatedAt: this.now().toISOString(),
      };
      return this.write(next, plan);
    });
  }

  /**
   * The panel's save: the whole plan, against the version the person opened. Refused with the
   * plan as it now stands when she (or another tab) saved it since; saving again against that
   * version is "keep mine".
   */
  save(plan: PlanDocument, basedOn: number): Promise<PlanSaveOutcome> {
    return this.queue(async () => {
      await this.load();
      const stored = this.plans.find((candidate) => candidate.id === plan.id) ?? null;
      if (stored !== null && stored.version !== basedOn) return { ok: false, current: stored, reason: 'She changed this plan while you were editing it.' };
      if (plan.title.trim() === '') return { ok: false, current: stored, reason: 'A plan needs a title.' };
      const next: PlanDocument = { ...plan, characterId: this.characterId, title: plan.title.trim(), version: (stored?.version ?? 0) + 1, updatedAt: this.now().toISOString() };
      const outcome = await this.write(next, stored);
      return outcome.ok ? outcome : { ok: false, current: this.plans.find((candidate) => candidate.id === plan.id) ?? null, reason: outcome.reason };
    });
  }

  /**
   * Her `plan_follow_up`: a day to ask about a plan. A plan may have several — "how the
   * clearing went" on Monday and "the soil" in a fortnight (seen live) — and a second one on
   * the same day replaces the first.
   */
  followUp(ref: string, on: string, about: string): Promise<PlanOutcome> {
    return this.queue(async () => {
      await this.load();
      const plan = this.find(ref);
      if (plan === null) return { ok: false, reason: this.unknown(ref) };
      if (this.facts === null) return { ok: false, reason: 'Follow-ups need memory, and memory is off.' };
      const when = followUpWhen(on);
      if (when === null) return { ok: false, reason: `"${on}" is not a date. Give it as YYYY-MM-DD, or YYYY-MM-DD HH:MM for a time.` };
      await this.closeFollowUps(plan, when);
      const at = this.now().toISOString();
      const fact: SemanticFact = {
        id: this.newId(),
        characterId: this.characterId,
        subject: planSubject(plan.title),
        predicate: FOLLOW_UP_PREDICATE,
        object: `${when}: ${about.trim()}`,
        confidence: 1,
        validFrom: at,
        validTo: null,
        recordedAt: at,
        sourceEpisodeId: null,
        embedding: null,
      };
      await this.facts.recordFact(fact);
      const follow = followUpOf(fact);
      if (follow !== null) this.follows = [...this.follows, follow];
      this.changed();
      return { ok: true, plan };
    });
  }

  /** Drop a plan's follow-up on one day, or all of them with `on` null — asked about, or no longer wanted. */
  cancelFollowUps(ref: string, on: string | null): Promise<PlanOutcome> {
    return this.queue(async () => {
      await this.load();
      const plan = this.find(ref);
      if (plan === null) return { ok: false, reason: this.unknown(ref) };
      const subject = planSubject(plan.title);
      on = on === null ? null : (followUpWhen(on) ?? on);
      if (!this.follows.some((follow) => follow.subject === subject && (on === null || follow.on === on))) {
        return { ok: false, reason: `"${plan.title}" has no follow-up${on === null ? '' : ` on ${on}`}.` };
      }
      await this.closeFollowUps(plan, on);
      this.changed();
      return { ok: true, plan };
    });
  }

  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private unknown(ref: string): string {
    const open = this.plans.filter((plan) => plan.status !== 'archived');
    return `There is no plan "${ref}". ${open.length === 0 ? 'There are no plans yet.' : `The plans are: ${open.map((plan) => `${plan.title} (id ${plan.id})`).join('; ')}.`}`;
  }

  /** An outline from her words, keeping the ids (and what she did not say) of phases and tasks whose titles match. */
  private outline(input: readonly PhaseInput[], before: readonly PlanPhase[]): PlanPhase[] {
    const oldTasks = before.flatMap((phase) => phase.tasks);
    return input
      .filter((phase) => phase.title.trim() !== '')
      .map((phase) => {
        const oldPhase = before.find((candidate) => same(candidate.title, phase.title));
        const tasks = (phase.tasks ?? [])
          .map((task): TaskInput => (typeof task === 'string' ? { title: task } : task))
          .filter((task) => task.title.trim() !== '')
          .map((task): PlanTask => {
            const old = oldPhase?.tasks.find((candidate) => same(candidate.title, task.title)) ?? oldTasks.find((candidate) => same(candidate.title, task.title));
            return { id: old?.id ?? this.newId(), title: task.title.trim(), status: task.status ?? old?.status ?? 'todo', notes: task.notes?.trim() ?? old?.notes ?? '' };
          });
        return { id: oldPhase?.id ?? this.newId(), title: phase.title.trim(), tasks };
      });
  }

  private async write(plan: PlanDocument, before: PlanDocument | null): Promise<PlanOutcome> {
    try {
      await this.store.savePlan(plan);
    } catch (error) {
      if (!(error instanceof MemoryStoreError) || error.code !== 'conflict') throw error;
      this.plans = await this.store.listPlans(this.characterId);
      this.changed();
      return { ok: false, reason: `"${plan.title}" was changed somewhere else just now; it is reloaded. Look again and try once more.` };
    }
    this.plans = [plan, ...this.plans.filter((candidate) => candidate.id !== plan.id)];
    if (isClosed(plan.status)) {
      if (this.focus === plan.id) this.focus = null;
      if (before === null || !isClosed(before.status)) await this.closeFollowUps(plan);
    } else {
      this.focus = plan.id;
    }
    this.changed();
    return { ok: true, plan };
  }

  /** Close a plan's follow-ups: those on `on`, or every one. */
  private async closeFollowUps(plan: PlanDocument, on: string | null = null): Promise<void> {
    const subject = planSubject(plan.title);
    const closing = this.follows.filter((follow) => follow.subject === subject && (on === null || follow.on === on));
    if (closing.length === 0 || this.facts === null) return;
    for (const follow of closing) await this.facts.closeFact(follow.factId);
    this.follows = this.follows.filter((follow) => !closing.includes(follow));
  }

  private changed(): void {
    this.current = { plans: [...this.plans], focusId: this.focus, followUps: [...this.follows] };
    for (const listener of this.listeners) listener();
  }
}
