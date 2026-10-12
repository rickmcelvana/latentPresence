import type { PlanDocument, SemanticFact } from '@latentpresence/protocol';
import { dayPart } from '../idle/catalogue';
import { factLine } from '../memory/recall';
import { FOLLOW_UP_PREDICATE, type PromptPlans } from '../plan/plans';
import { numberWord } from '../time/words';

/**
 * Her initiative (P6-T03, ADR-52): whether she says something nobody asked for, and what.
 *
 * **Pure, clock passed in.** Everything she might say is decided here, before any model is asked:
 * a model always answers something, so silence is a decision made in code. The budget is per
 * rolling 24 hours and counts every turn she starts, the opener (ADR-51) included; the ledger of
 * what she started is kept by the caller (a `_initiative` system block) so a reload does not
 * reset it.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const INITIATIVE_WINDOW_MS = 24 * HOUR_MS;

/** The person's setting. Off: she never starts a turn, the opener included. */
export type InitiativeDial = 'off' | 'rare' | 'normal';
export type InitiativeKind = 'opener' | 'follow-up' | 'thought';

export interface InitiativeBudget {
  /** Turns she may start in any 24 hours, the opener included. */
  readonly perDay: number;
  /** Between two check-ins (the opener is exempt: they have just come back). */
  readonly gapMs: number;
  /** Quiet before a due follow-up is raised. */
  readonly followUpQuietMs: number;
  /** Quiet before a thought; null: no thoughts at this setting. */
  readonly thoughtQuietMs: number | null;
  /**
   * Thoughts in any 24 hours. The simulated day spent normal's whole budget on thoughts by noon
   * and had nothing left for a follow-up due at five; follow-ups keep the rest.
   */
  readonly thoughtsPerDay: number;
}

export const INITIATIVE_BUDGETS: Readonly<Record<Exclude<InitiativeDial, 'off'>, InitiativeBudget>> = {
  rare: { perDay: 2, gapMs: 3 * HOUR_MS, followUpQuietMs: 5 * MINUTE_MS, thoughtQuietMs: null, thoughtsPerDay: 0 },
  normal: { perDay: 6, gapMs: 45 * MINUTE_MS, followUpQuietMs: 2 * MINUTE_MS, thoughtQuietMs: 20 * MINUTE_MS, thoughtsPerDay: 2 },
};

/**
 * One turn she started. `key` names what it was about, so it is not raised again within a day;
 * `answered` is kept with it, so a reload does not forget that she is still waiting (the simulated
 * day found exactly that).
 */
export interface InitiativeEntry {
  readonly at: number;
  readonly kind: InitiativeKind;
  readonly key: string | null;
  readonly answered: boolean;
}

/** A follow-up that has come due. `timed`: set for a time of day, which may be at night. */
export interface DueFollowUp {
  readonly key: string;
  readonly plan: string;
  readonly about: string;
  readonly timed: boolean;
}

/** Something real she could bring up in a quiet moment: a plan's next step, or a fact. */
export interface ThoughtTopic {
  readonly key: string;
  readonly about: string;
}

export interface InitiativeSituation {
  readonly now: Date;
  readonly dial: InitiativeDial;
  readonly ledger: readonly InitiativeEntry[];
  /** Since anything last happened: their words, her words, a tool. */
  readonly quietMs: number;
  /** They are speaking or typing, a voice panel or a permission prompt is open, or she is busy. */
  readonly blocked: boolean;
  /** Her last turn of her own has had no answer yet. */
  readonly unanswered: boolean;
  readonly followUps: readonly DueFollowUp[];
  readonly thoughts: readonly ThoughtTopic[];
}

export interface InitiativeDecision {
  readonly kind: 'follow-up' | 'thought';
  readonly key: string;
  /** The hidden turn she answers (ADR-51's cue, with the reason). */
  readonly cue: string;
}

function inWindow(ledger: readonly InitiativeEntry[], now: number): InitiativeEntry[] {
  return ledger.filter((entry) => entry.at > now - INITIATIVE_WINDOW_MS && entry.at <= now);
}

/** She may start a turn now as far as the count goes (the opener's whole test, beside ADR-51's hour). */
export function withinBudget(dial: InitiativeDial, ledger: readonly InitiativeEntry[], now: number): boolean {
  if (dial === 'off') return false;
  return inWindow(ledger, now).length < INITIATIVE_BUDGETS[dial].perDay;
}

/** Long enough since her last check-in (openers do not count towards the gap). */
function pastGap(budget: InitiativeBudget, ledger: readonly InitiativeEntry[], now: number): boolean {
  const last = ledger.filter((entry) => entry.kind !== 'opener').reduce((latest, entry) => Math.max(latest, entry.at), Number.NEGATIVE_INFINITY);
  return now - last >= budget.gapMs;
}

/** "a few minutes", "about twenty minutes", "about half an hour", "about an hour", "a while". */
export function quietWords(ms: number): string {
  const minutes = ms / MINUTE_MS;
  if (minutes < 10) return 'a few minutes';
  if (minutes < 25) return `about ${numberWord(Math.round(minutes / 5) * 5)} minutes`;
  if (minutes < 40) return 'about half an hour';
  if (minutes < 90) return 'about an hour';
  return 'a while';
}

export function initiativeCue(kind: 'follow-up' | 'thought', about: string, quietMs: number): string {
  if (kind === 'follow-up') {
    return `(Nothing has been said for ${quietWords(quietMs)}. A follow-up you offered is due now: ${about}. Bring it up yourself, the way a friend would: one or two short sentences and one question. Leave the follow-up in place until they answer.)`;
  }
  return `(It has been quiet for ${quietWords(quietMs)}. Say one short thing that has been on your mind about ${about}, the way a friend would in a quiet moment: one or two sentences, one question at most. Do not remark on the silence.)`;
}

/**
 * What she says now, or null for silence. In order: a due follow-up not raised in the last day;
 * then, at `normal` and not at night, a thought not raised in the last day. A follow-up set for a
 * time is allowed at night — they asked for that time — a follow-up set for a day is not.
 */
export function decideInitiative(situation: InitiativeSituation): InitiativeDecision | null {
  const { dial, ledger, quietMs } = situation;
  if (dial === 'off' || situation.blocked || situation.unanswered) return null;
  const now = situation.now.getTime();
  const budget = INITIATIVE_BUDGETS[dial];
  if (!withinBudget(dial, ledger, now) || !pastGap(budget, ledger, now)) return null;
  const day = inWindow(ledger, now);
  const raised = new Set(day.map((entry) => entry.key));
  const night = dayPart(situation.now.getHours()) === 'night';

  if (quietMs >= budget.followUpQuietMs) {
    const due = situation.followUps.find((follow) => !raised.has(follow.key) && (follow.timed || !night));
    if (due !== undefined) return { kind: 'follow-up', key: due.key, cue: initiativeCue('follow-up', `${due.plan} — ${due.about}`, quietMs) };
  }
  const thoughts = day.filter((entry) => entry.kind === 'thought').length;
  if (budget.thoughtQuietMs !== null && quietMs >= budget.thoughtQuietMs && !night && thoughts < budget.thoughtsPerDay) {
    const topic = situation.thoughts.find((candidate) => !raised.has(candidate.key));
    if (topic !== undefined) return { kind: 'thought', key: topic.key, cue: initiativeCue('thought', topic.about, quietMs) };
  }
  return null;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** The follow-ups in her prompt that have come due by `now` (the plans section's own test). */
export function dueFollowUps(followUps: PromptPlans['followUps'], now: Date): DueFollowUp[] {
  const key = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  return followUps
    .filter((follow) => follow.on <= key)
    .map((follow) => ({ key: `follow:${follow.plan}:${follow.on}`, plan: follow.plan, about: follow.about, timed: follow.on.length > 10 }));
}

/** At most this many thought topics are offered: the first not raised in a day is taken. */
export const MAX_THOUGHTS = 8;

/**
 * What she could bring up in a quiet moment: each active plan's next open step, then what she
 * knows about them, newest first. Follow-ups are not facts here (they have their own turn).
 */
export function thoughtTopics(plans: readonly PlanDocument[], facts: readonly SemanticFact[]): ThoughtTopic[] {
  const steps = plans.flatMap((plan) => {
    if (plan.status !== 'active') return [];
    const next = plan.phases.flatMap((phase) => phase.tasks).find((task) => task.status === 'todo' || task.status === 'doing');
    // "Your plan" read as hers in the live check ("I should dig it in this weekend"): it is theirs.
    return next === undefined ? [] : [{ key: `plan:${plan.id}:${next.title}`, about: `the plan you are making with them, "${plan.title}" (their next step: ${next.title})` }];
  });
  const known = facts
    .filter((fact) => fact.predicate !== FOLLOW_UP_PREDICATE)
    .toSorted((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
    .map((fact) => ({ key: `fact:${fact.id}`, about: `something they told you (${factLine(fact)})` }));
  return [...steps, ...known].slice(0, MAX_THOUGHTS);
}

const KINDS: ReadonlySet<string> = new Set(['opener', 'follow-up', 'thought']);

/** The ledger as the system block holds it: entries in the last 24 h. Anything unreadable is none. */
export function parseLedger(text: string | null, now: number): InitiativeEntry[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    const entries = typeof parsed === 'object' && parsed !== null && 'spoke' in parsed && Array.isArray(parsed.spoke) ? (parsed.spoke as unknown[]) : [];
    return inWindow(
      entries.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { at, kind, key, answered } = entry as Record<string, unknown>;
        if (typeof at !== 'number' || typeof kind !== 'string' || !KINDS.has(kind)) return [];
        return [{ at, kind: kind as InitiativeKind, key: typeof key === 'string' ? key : null, answered: answered !== false }];
      }),
      now,
    );
  } catch {
    return [];
  }
}

export function serializeLedger(ledger: readonly InitiativeEntry[], now: number): string {
  return JSON.stringify({ spoke: inWindow(ledger, now) });
}
