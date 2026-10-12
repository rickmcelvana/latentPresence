import { IDLE_ACTIVITIES, dayPart, type IdleActivity } from './catalogue';

/**
 * The idle planner (P6-T01, ADR-50): a utility system choosing what she does when nobody is
 * talking. Pure: the clock is in the context and the randomness is injected, so an hour can be
 * simulated in a test and two runs with one seed are the same hour.
 */

/** No activity comes back within this long: the done-when, as a rule rather than a likelihood. */
export const IDLE_COOLDOWN_MS = 10 * 60 * 1000;

/** What she is like and what is around her, right now. */
export interface IdleContext {
  readonly now: Date;
  /** How long it has been quiet. */
  readonly quietMs: number;
  /** Her mood's pleasure, −1..1 (`AffectState.mood.pleasure`). */
  readonly pleasure: number;
  /** Her energy, 0..1 (`AffectState.energy`). */
  readonly energy: number;
  /** What the room's boards show (ADR-49): reading one that is blank is not an activity. */
  readonly showing: { readonly whiteboard: boolean; readonly screen: boolean };
}

export interface IdleChoice {
  readonly activity: IdleActivity;
  readonly durationMs: number;
}

export interface IdleScore {
  readonly activity: IdleActivity;
  readonly score: number;
}

/** A seeded `[0, 1)` source: mulberry32, as the life layer uses. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function within(value: number, [low, high]: readonly [number, number]): boolean {
  return value >= low && value <= high;
}

/**
 * A rest between activities: 45–120 s, up to 1.8× when she is low on energy. At 15–45 s an hour
 * held 57–71 things to do, which reads as fidgeting rather than living (first simulation).
 */
const REST_MS: readonly [number, number] = [45_000, 120_000];

/**
 * After its cooldown an activity's odds come back over this long, not at once: with the full
 * weight back at ten minutes, each one recurred right on the cooldown, a cycle you could see.
 */
const FRESH_MS = 30 * 60 * 1000;

/**
 * Doing nothing competes in the draw: when little fits (late, tired, low) a few activities would
 * otherwise take every turn between them, which repeats where a person would simply be still.
 */
export const IDLE_REST_SCORE = 1.5;

export class IdlePlanner {
  private readonly random: () => number;
  private readonly catalogue: readonly IdleActivity[];
  private readonly cooldownMs: number;
  /** When each activity last started, epoch ms. */
  private readonly lastDone = new Map<string, number>();
  private lastKind: IdleActivity['kind'] | null = null;

  private readonly restScore: number;

  constructor(options: { readonly random: () => number; readonly catalogue?: readonly IdleActivity[]; readonly cooldownMs?: number; readonly restScore?: number }) {
    this.random = options.random;
    this.catalogue = options.catalogue ?? IDLE_ACTIVITIES;
    this.cooldownMs = options.cooldownMs ?? IDLE_COOLDOWN_MS;
    this.restScore = options.restScore ?? IDLE_REST_SCORE;
  }

  /** Every activity's utility now; zero is not eligible. */
  scores(context: IdleContext): IdleScore[] {
    const part = dayPart(context.now.getHours());
    const at = context.now.getTime();
    return this.catalogue.map((activity) => {
      const last = this.lastDone.get(activity.id);
      const cooling = last !== undefined && at - last < Math.max(this.cooldownMs, activity.cooldownMs ?? 0);
      const fits =
        !cooling &&
        context.quietMs >= activity.afterMs &&
        within(context.pleasure, activity.pleasure) &&
        within(context.energy, activity.energy) &&
        (activity.about === undefined || context.showing[activity.about]);
      if (!fits) return { activity, score: 0 };
      const day = activity.day?.[part] ?? 1;
      const novelty = activity.kind === this.lastKind ? 0.5 : 1;
      const fresh = last === undefined ? 1 : Math.min(1, (at - last) / FRESH_MS);
      return { activity, score: activity.weight * day * novelty * fresh };
    });
  }

  /** What she does next, or null — nothing fits, or stillness won the draw: she rests. Records it. */
  choose(context: IdleContext): IdleChoice | null {
    const eligible = this.scores(context).filter((entry) => entry.score > 0);
    const total = eligible.reduce((sum, entry) => sum + entry.score, 0);
    if (total <= 0) return null;
    let pick = this.random() * (total + this.restScore);
    let chosen: IdleScore | null = null;
    for (const entry of eligible) {
      pick -= entry.score;
      if (pick < 0) {
        chosen = entry;
        break;
      }
    }
    if (chosen === null) return null;
    const [low, high] = chosen.activity.durationMs;
    this.lastDone.set(chosen.activity.id, context.now.getTime());
    this.lastKind = chosen.activity.kind;
    return { activity: chosen.activity, durationMs: Math.round(low + (high - low) * this.random()) };
  }

  /** How long she rests before the next one. */
  restMs(context: IdleContext): number {
    const [low, high] = REST_MS;
    const tired = 1 + (1 - Math.min(1, Math.max(0, context.energy))) * 0.8;
    return Math.round((low + (high - low) * this.random()) * tired);
  }
}
