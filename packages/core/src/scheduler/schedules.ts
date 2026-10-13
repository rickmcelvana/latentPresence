import type { CatchUpPolicy, DeliveryMode, MemoryStore, Schedule } from '@latentpresence/protocol';
import { CronError, nextFiring, parseCron, wallTimeToInstant } from './cron';
import { markDelivered as markRunDelivered } from './runner';
import { clockWords } from './words';

/**
 * The page's schedules (P6-T08, ADR-58): what she makes with `schedule_create` and the person
 * pauses, resumes and cancels in the panel, held as `Plans` holds plans — a snapshot replaced on
 * every change and never mutated, `subscribe` for the panel, and **one queue for every write**,
 * hers and the panel's, so the two cannot race inside a page.
 *
 * Unlike plans, the list is **re-read on every `load()`**: the scheduler (or the companion) moves
 * `nextRunAt`, keeps `lastRun` and completes one-shots behind this object's back, so every write
 * starts from what the store holds now and never from a copy that has gone stale.
 *
 * **She reads the words; the code reads the clock** (ADR-58 decision 2): `at` is a wall-clock time
 * in the person's zone, turned into an instant by `wallTimeToInstant`.
 */

/** A reminder this far ahead is as long as a week; anything further is a date, not a count of minutes. */
export const MAX_IN_MINUTES = 7 * 24 * 60;
const MAX_DESCRIPTION = 200;

export interface ScheduleRequest {
  /** What it is, 1–200 characters: the message of a reminder, the name of a task. */
  readonly description: string;
  /** `YYYY-MM-DDTHH:MM` in the person's zone. */
  readonly at?: string | undefined;
  /** Whole minutes from now, 1..10080. */
  readonly inMinutes?: number | undefined;
  /** A five-field cron line, in the person's zone. */
  readonly repeat?: string | undefined;
  /** What to do when it is time; empty or absent is a reminder, which asks no model. */
  readonly task?: string | undefined;
  /** Tool names the task may use (hers, now); only with a task. */
  readonly tools?: readonly string[] | undefined;
  readonly delivery?: DeliveryMode | undefined;
  readonly catchUp?: CatchUpPolicy | undefined;
}

/** (Not `ScheduleOutcome`: that is a run's result, in `execute.ts`.) */
export type ScheduleResult = { readonly ok: true; readonly schedule: Schedule } | { readonly ok: false; readonly reason: string };

export interface SchedulesOptions {
  readonly store: Pick<MemoryStore, 'listSchedules' | 'saveSchedule'>;
  readonly characterId: string;
  /** The person's IANA zone. */
  readonly timeZone: string;
  /** Memory is the companion: a reminder runs there, with the page closed (ADR-57). */
  readonly companion: boolean;
  /** Hers, now: what `tools` may name. Absent, any name is taken. */
  readonly toolNames?: () => readonly string[];
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function norm(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/gu, ' ').trim();
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `sched-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isLive(schedule: Schedule): boolean {
  return schedule.status === 'active' || schedule.status === 'paused';
}

const nextAt = (schedule: Schedule): number => (schedule.nextRunAt === null ? Number.POSITIVE_INFINITY : Date.parse(schedule.nextRunAt));
const lastActive = (schedule: Schedule): number => Date.parse(schedule.lastRunAt ?? schedule.createdAt);
const newestFirst = (a: Schedule, b: Schedule): number => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/** Upcoming first (active by next run, then paused), then the finished, newest activity first. */
function ordered(schedules: readonly Schedule[]): Schedule[] {
  const live = schedules.filter(isLive).toSorted((a, b) => Number(a.status === 'paused') - Number(b.status === 'paused') || nextAt(a) - nextAt(b));
  const done = schedules.filter((schedule) => !isLive(schedule)).toSorted((a, b) => lastActive(b) - lastActive(a));
  return [...live, ...done];
}

export class Schedules {
  readonly characterId: string;
  readonly timeZone: string;
  private readonly store: SchedulesOptions['store'];
  private readonly companion: boolean;
  private readonly toolNames: (() => readonly string[]) | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private all: Schedule[] = [];
  private current: readonly Schedule[] = [];
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: SchedulesOptions) {
    this.store = options.store;
    this.characterId = options.characterId;
    this.timeZone = options.timeZone;
    this.companion = options.companion;
    this.toolNames = options.toolNames;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  /**
   * Read the schedules from the store. Every call reads again (the page refreshes this on each
   * tick); a failed read is thrown and leaves what was there, so the next call tries afresh.
   */
  load(): Promise<void> {
    return this.queue(() => this.refresh());
  }

  /** Everything the panel shows, replaced (never mutated) on every change. Never waits. */
  snapshot(): readonly Schedule[] {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A schedule by id, or failing that by its description, as a person would say it (newest active one first). */
  find(ref: string): Schedule | null {
    const byId = this.all.find((schedule) => schedule.id === ref);
    if (byId !== undefined) return byId;
    const wanted = norm(ref);
    if (wanted === '') return null;
    const matches = this.all.filter((schedule) => norm(schedule.description) === wanted);
    return matches.filter((schedule) => schedule.status === 'active').toSorted(newestFirst)[0] ?? matches.toSorted(newestFirst)[0] ?? null;
  }

  /** Her `schedule_create`. Saved at once; the reply reads the time back from the code's words. */
  create(request: ScheduleRequest): Promise<ScheduleResult> {
    return this.queue(async () => {
      await this.refresh();
      const description = request.description.trim();
      if (description === '' || description.length > MAX_DESCRIPTION) return refuse(`The description must be 1 to ${MAX_DESCRIPTION} characters; it is what is said when the time comes.`);
      const given = [request.at !== undefined, request.inMinutes !== undefined, request.repeat !== undefined].filter(Boolean).length;
      if (given !== 1) return refuse('Give exactly one of "at" (a time, YYYY-MM-DDTHH:MM in their own clock), "in_minutes" (a count of minutes from now) or "repeat" (a five-field cron line like "0 9 * * *").');
      const task = request.task?.trim() ?? '';
      const tools = request.tools ?? [];
      if (tools.length > 0 && task === '') return refuse('"tools" go with a "task" — a plain reminder uses none. Leave "tools" out, or say what the task is.');
      if (this.toolNames !== undefined) {
        const have = this.toolNames();
        const unknown = tools.find((name) => !have.includes(name));
        if (unknown !== undefined) return refuse(`You do not have a tool called "${unknown}". Your tools are: ${have.length === 0 ? 'none' : have.join(', ')}.`);
      }

      const now = this.now();
      let trigger: Schedule['trigger'];
      let next: Date;
      let once = true;
      if (request.at !== undefined) {
        let when: Date | null;
        try {
          when = wallTimeToInstant(request.at.trim(), this.timeZone);
        } catch (error) {
          return refuse(error instanceof Error ? error.message : String(error));
        }
        if (when === null) return refuse(`"${request.at}" is not a time — give YYYY-MM-DDTHH:MM, like ${exampleTime(now, this.timeZone)}.`);
        if (when.getTime() <= now.getTime()) return refuse(`${request.at} has already passed: it is ${clockWords(now, now, this.timeZone)} now. Give a time after that.`);
        next = when;
        trigger = { kind: 'once', at: when.toISOString() };
      } else if (request.inMinutes !== undefined) {
        if (!Number.isInteger(request.inMinutes) || request.inMinutes < 1 || request.inMinutes > MAX_IN_MINUTES) {
          return refuse(`"in_minutes" must be a whole number of minutes from 1 to ${MAX_IN_MINUTES} (a week). For a later time, give "at".`);
        }
        next = new Date(now.getTime() + request.inMinutes * 60_000);
        trigger = { kind: 'once', at: next.toISOString() };
      } else {
        once = false;
        const expression = (request.repeat ?? '').trim();
        trigger = { kind: 'cron', expression, timeZone: this.timeZone };
        try {
          parseCron(expression, this.timeZone);
        } catch (error) {
          if (error instanceof CronError) return refuse(`"${expression}" cannot repeat: ${error.message}`);
          throw error;
        }
        const first = nextFiring(trigger, now);
        if (first === null) return refuse(`"${expression}" never comes round. Give a repeat that does, like "0 9 * * *" for every day at 9.`);
        next = first;
      }

      const schedule: Schedule = {
        id: this.newId(),
        characterId: this.characterId,
        description,
        trigger,
        taskPrompt: task,
        allowedTools: [...tools],
        delivery: request.delivery ?? 'notify',
        // A reminder missed while away is still said, late; a daily job missed is not worth running twice.
        catchUp: request.catchUp ?? (once ? 'run_once' : 'skip'),
        runOn: this.companion && task === '' ? 'companion' : 'core',
        status: 'active',
        lastRunAt: null,
        nextRunAt: next.toISOString(),
        createdAt: now.toISOString(),
        toolCall: null,
        lastRun: null,
      };
      await this.store.saveSchedule(schedule);
      this.all = [...this.all, schedule];
      this.changed();
      return { ok: true, schedule };
    });
  }

  /** Stop it running until resumed; it keeps its place and its history. */
  pause(ref: string): Promise<ScheduleResult> {
    return this.change(ref, ['active'], 'paused', (schedule) => ({ ...schedule, status: 'paused' }));
  }

  /** Start it again from now: a paused job does not catch up on what passed while it was paused. */
  resume(ref: string): Promise<ScheduleResult> {
    return this.change(ref, ['paused'], 'resumed', (schedule) => {
      const next = nextFiring(schedule.trigger, this.now());
      return next === null ? 'its time has passed — make a new one' : { ...schedule, status: 'active', nextRunAt: next.toISOString() };
    });
  }

  /** Never deletes: it stays, cancelled, so its history does. */
  cancel(ref: string): Promise<ScheduleResult> {
    return this.change(ref, ['active', 'paused'], 'cancelled', (schedule) => ({ ...schedule, status: 'cancelled', nextRunAt: null }));
  }

  /** The runs just told (or shown) are marked so; the others are left as they are. */
  markDelivered(ids: readonly string[], at: Date): Promise<void> {
    return this.queue(async () => {
      await this.refresh();
      for (const id of ids) {
        const schedule = this.all.find((candidate) => candidate.id === id);
        if (schedule === undefined || schedule.lastRun === null || schedule.lastRun.deliveredAt !== null) continue;
        const told = markRunDelivered(schedule, at);
        await this.store.saveSchedule(told);
        this.all = this.all.map((candidate) => (candidate.id === id ? told : candidate));
      }
      this.changed();
    });
  }

  private change(ref: string, from: readonly Schedule['status'][], action: 'paused' | 'resumed' | 'cancelled', apply: (schedule: Schedule) => Schedule | string): Promise<ScheduleResult> {
    return this.queue(async () => {
      await this.refresh();
      const schedule = this.find(ref);
      if (schedule === null) return refuse(this.unknown(ref));
      if (!from.includes(schedule.status)) return refuse(`"${schedule.description}" is ${schedule.status}, so it cannot be ${action}.`);
      const next = apply(schedule);
      if (typeof next === 'string') return refuse(`"${schedule.description}": ${next}.`);
      await this.store.saveSchedule(next);
      this.all = this.all.map((candidate) => (candidate.id === next.id ? next : candidate));
      this.changed();
      return { ok: true, schedule: next };
    });
  }

  private async refresh(): Promise<void> {
    this.all = await this.store.listSchedules(this.characterId);
    this.changed();
  }

  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private unknown(ref: string): string {
    const live = this.all.filter(isLive);
    return `There is no schedule "${ref}". ${live.length === 0 ? 'Nothing is scheduled.' : `The schedules are: ${live.map((schedule) => `${schedule.description} (id ${schedule.id})`).join('; ')}.`}`;
  }

  private changed(): void {
    this.current = ordered(this.all);
    for (const listener of this.listeners) listener();
  }
}

function refuse(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}

/** A well-formed example for a refusal to point at: tomorrow, 09:00, in the person's zone. */
function exampleTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now.getTime() + 24 * 60 * 60_000));
  return `${parts}T09:00`;
}
