import type {
  AffectState,
  CharacterEmotion,
  ConversationEvent,
  EmotionEvent,
  EmotionSource,
  SocialStance,
  UserAffect,
  UserEmotion,
} from '@latentpresence/protocol';
import { DEFAULT_AFFECT_PARAMS, EMOTION_PAD, EMOTION_STANCE, type AffectParams } from './params';

/**
 * The affect engine's core (P3-T01, ADR-12): pure functions over `AffectState` with a fixed
 * timestep, and a small queue in front of them.
 *
 * - **Mood** (PAD) relaxes towards the baseline with a half-life and is pulled by whatever
 *   the character is feeling now, towards each feeling's PAD point.
 * - **Events** are fast feelings — an `[emote:x]` tag, the user's apparent mood caught by
 *   empathy — each halving on its own half-life and dropped once negligible. They are stored
 *   as they began (intensity and `at`), so the current strength is a function of time and
 *   nothing is mutated to age them.
 * - **Energy** relaxes the same way and is moved by the feelings' arousal; **stance**'s
 *   warmth and engagement by a per-feeling table, formality only when told.
 *
 * **Bounded by construction, not by clamping.** Relaxation is a convex step towards a
 * baseline inside the range, and a push moves a fraction `min(1, gain·dt·|push|)` of the way
 * to the range's edge — so no input, however large or frequent, can leave the range. The
 * property tests throw random inputs at it to hold that.
 *
 * **Fixed timestep** (`stepMs`): the state only ever moves in whole steps from its
 * `updatedAt`, and an input lands on the first boundary at or after it. So the same inputs
 * give the same state whether it is ticked every frame or once a minute. A long gap — a
 * week away, restored from storage — steps only while events are alive (their half-life is
 * capped) and then jumps the rest in closed form, which with no push is exact.
 */

export type AffectInput =
  /** A feeling: from an `[emote:x]` tag, a memory, a schedule. `neutral` is no feeling. */
  | {
      readonly type: 'emotion';
      readonly at: number;
      readonly label: CharacterEmotion;
      readonly intensity: number;
      readonly source: EmotionSource;
      readonly halfLifeMs?: number;
    }
  /** How the user seems (P3-T04/T05): caught as a feeling of the character's own, by `empathy`. */
  | { readonly type: 'user-affect'; readonly at: number; readonly affect: UserAffect }
  /** A direct nudge to stance, clamped: the conversation's own events will send these. */
  | { readonly type: 'stance'; readonly at: number; readonly delta: Partial<SocialStance> }
  /** A direct nudge to energy, clamped. */
  | { readonly type: 'energy'; readonly at: number; readonly delta: number };

/** What the character feels in response to how the user seems. */
const EMPATHY: Readonly<Record<UserEmotion, CharacterEmotion | null>> = {
  neutral: null,
  happy: 'joy',
  sad: 'concern',
  angry: 'concern',
  fearful: 'concern',
  disgusted: 'concern',
  surprised: 'surprise',
  other: null,
  unknown: null,
};

const LN2 = Math.LN2;

function ms(stamp: string): number {
  return Date.parse(stamp);
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Relax `value` towards `base` over `dtMs` with half-life `halfLifeMs`: a convex step. */
function relax(value: number, base: number, dtMs: number, halfLifeMs: number): number {
  return base + (value - base) * Math.exp((-LN2 * dtMs) / halfLifeMs);
}

/** Move `value` a bounded fraction of the way to the edge `push` points at. */
function pushed(value: number, push: number, gainDt: number, lo: number, hi: number): number {
  if (push === 0) return value;
  const rate = Math.min(1, gainDt * Math.abs(push));
  return push > 0 ? value + rate * (hi - value) : value - rate * (value - lo);
}

/** An event's strength at `at`: it halves every `halfLifeMs` after it began. */
export function eventIntensity(event: EmotionEvent, at: number): number {
  const age = Math.max(0, at - ms(event.at));
  return event.intensity * Math.exp((-LN2 * age) / event.halfLifeMs);
}

/** The character at rest: baseline mood, energy and stance, feeling nothing in particular. */
export function initialAffect(characterId: string, at: number, params: AffectParams = DEFAULT_AFFECT_PARAMS): AffectState {
  const { baseline } = params;
  return {
    characterId,
    mood: { ...baseline.mood },
    events: [],
    energy: baseline.energy,
    stance: { ...baseline.stance },
    updatedAt: iso(at),
  };
}

/**
 * The state as numbers, for stepping: ISO strings are for storage, and building one per
 * 100 ms step made a day's catch-up the dominant cost (13 s for 300 test runs).
 */
interface Working {
  at: number;
  pleasure: number;
  arousal: number;
  dominance: number;
  energy: number;
  warmth: number;
  formality: number;
  engagement: number;
  events: { readonly event: EmotionEvent; readonly at: number }[];
}

function working(state: AffectState): Working {
  return {
    at: ms(state.updatedAt),
    ...state.mood,
    energy: state.energy,
    ...state.stance,
    events: state.events.map((event) => ({ event, at: ms(event.at) })),
  };
}

function settled(state: AffectState, w: Working): AffectState {
  return {
    ...state,
    mood: { pleasure: w.pleasure, arousal: w.arousal, dominance: w.dominance },
    energy: w.energy,
    stance: { warmth: w.warmth, formality: w.formality, engagement: w.engagement },
    events: w.events.map(({ event }) => event),
    updatedAt: iso(w.at),
  };
}

/** One fixed step of `dtMs` (a whole number of steps when nothing is pushing), in place. */
function step(w: Working, dtMs: number, params: AffectParams): void {
  w.at += dtMs;
  const { baseline } = params;
  const push = { pleasure: 0, arousal: 0, dominance: 0, warmth: 0, engagement: 0 };
  const live: Working['events'] = [];
  for (const entry of w.events) {
    const now = entry.event.intensity * Math.exp((-LN2 * Math.max(0, w.at - entry.at)) / entry.event.halfLifeMs);
    if (now < params.negligible) continue;
    live.push(entry);
    const pad = EMOTION_PAD[entry.event.label];
    const stance = EMOTION_STANCE[entry.event.label];
    push.pleasure += now * pad.pleasure;
    push.arousal += now * pad.arousal;
    push.dominance += now * pad.dominance;
    push.warmth += now * stance.warmth;
    push.engagement += now * stance.engagement;
  }
  w.events = live;

  const seconds = dtMs / 1000;
  const moodGain = params.moodGainPerSecond * seconds;
  const stanceGain = params.stanceGainPerSecond * seconds;
  w.pleasure = pushed(relax(w.pleasure, baseline.mood.pleasure, dtMs, params.moodHalfLifeMs), push.pleasure, moodGain, -1, 1);
  w.arousal = pushed(relax(w.arousal, baseline.mood.arousal, dtMs, params.moodHalfLifeMs), push.arousal, moodGain, -1, 1);
  w.dominance = pushed(relax(w.dominance, baseline.mood.dominance, dtMs, params.moodHalfLifeMs), push.dominance, moodGain, -1, 1);
  w.energy = pushed(relax(w.energy, baseline.energy, dtMs, params.energyHalfLifeMs), push.arousal, params.energyGainPerSecond * seconds, 0, 1);
  w.warmth = pushed(relax(w.warmth, baseline.stance.warmth, dtMs, params.stanceHalfLifeMs), push.warmth, stanceGain, -1, 1);
  w.formality = relax(w.formality, baseline.stance.formality, dtMs, params.stanceHalfLifeMs);
  w.engagement = pushed(relax(w.engagement, baseline.stance.engagement, dtMs, params.stanceHalfLifeMs), push.engagement, stanceGain, -1, 1);
}

/**
 * Advance to `to` in whole steps; the remainder waits for the next call. Steps one at a
 * time while any event is alive, then jumps: with nothing pushing, relaxation over `k`
 * steps is exactly one relaxation over their sum.
 */
export function advanceAffect(state: AffectState, to: number, params: AffectParams = DEFAULT_AFFECT_PARAMS): AffectState {
  let steps = Math.floor((to - ms(state.updatedAt)) / params.stepMs);
  if (steps <= 0) return state;
  const w = working(state);
  while (steps > 0) {
    if (w.events.length === 0) {
      step(w, steps * params.stepMs, params);
      break;
    }
    step(w, params.stepMs, params);
    steps -= 1;
  }
  return settled(state, w);
}

function addEvent(state: AffectState, event: EmotionEvent, params: AffectParams): AffectState {
  if (event.label === 'neutral' || event.intensity < params.negligible) return state;
  const at = ms(state.updatedAt);
  const events = [...state.events, event];
  if (events.length > params.maxEvents) {
    // The weakest now goes first; the newest is never the one dropped unless it is weakest.
    let weakest = 0;
    for (const [index, candidate] of events.entries()) {
      if (eventIntensity(candidate, at) < eventIntensity(events[weakest] ?? candidate, at)) weakest = index;
    }
    events.splice(weakest, 1);
  }
  return { ...state, events };
}

/** Apply one input at the state's own time. The caller has advanced to the input first. */
export function applyAffectInput(state: AffectState, input: AffectInput, params: AffectParams = DEFAULT_AFFECT_PARAMS): AffectState {
  const halfLife = (requested: number | undefined): number =>
    Math.round(clamp(requested ?? params.eventHalfLifeMs, params.stepMs, params.maxEventHalfLifeMs));
  switch (input.type) {
    case 'emotion':
      return addEvent(
        state,
        {
          label: input.label,
          intensity: clamp(input.intensity, 0, 1),
          source: input.source,
          at: state.updatedAt,
          halfLifeMs: halfLife(input.halfLifeMs),
        },
        params,
      );
    case 'user-affect': {
      const label = EMPATHY[input.affect.label];
      if (label === null) return state;
      const intensity = clamp(params.empathy * input.affect.confidence, 0, 1);
      return addEvent(state, { label, intensity, source: 'user-affect', at: state.updatedAt, halfLifeMs: halfLife(undefined) }, params);
    }
    case 'stance': {
      const nudge = (key: keyof SocialStance): number => clamp(state.stance[key] + (input.delta[key] ?? 0), -1, 1);
      return { ...state, stance: { warmth: nudge('warmth'), formality: nudge('formality'), engagement: nudge('engagement') } };
    }
    case 'energy':
      return { ...state, energy: clamp(state.energy + input.delta, 0, 1) };
  }
}

/** The strongest feeling now, or `neutral` when nothing is felt above `negligible`. */
export function dominantEmotion(state: AffectState, params: AffectParams = DEFAULT_AFFECT_PARAMS): { label: CharacterEmotion; intensity: number } {
  const at = ms(state.updatedAt);
  let best: { label: CharacterEmotion; intensity: number } = { label: 'neutral', intensity: 0 };
  for (const event of state.events) {
    const now = eventIntensity(event, at);
    if (now >= params.negligible && now > best.intensity) best = { label: event.label, intensity: now };
  }
  return best;
}

/**
 * The bus as affect inputs: an `[emote:x]` tag the model wrote becomes a feeling (ADR-12),
 * and the user's fused affect is caught by empathy. Unknown emote labels are ignored — the
 * tag bridge already shows what it can of them.
 */
export function affectInputsFrom(event: ConversationEvent, params: AffectParams = DEFAULT_AFFECT_PARAMS): AffectInput[] {
  if (event.type === 'assistant.sentence') {
    return event.tags.flatMap((tag): AffectInput[] =>
      tag.kind === 'emote' && tag.known !== null && tag.known in EMOTION_PAD
        ? [{ type: 'emotion', at: ms(event.at), label: tag.known as CharacterEmotion, intensity: params.tagIntensity, source: 'llm-tag' }]
        : [],
    );
  }
  if (event.type === 'affect.user.updated') return [{ type: 'user-affect', at: ms(event.at), affect: event.affect }];
  return [];
}

/**
 * The queue in front of the pure functions. Inputs may arrive in any order and early; each
 * lands on the first step boundary at or after its own time, never before the state's —
 * an input older than the state is applied now rather than rewriting what already happened.
 */
export class AffectEngine {
  private current: AffectState;
  private readonly params: AffectParams;
  private readonly queue: AffectInput[] = [];

  constructor(state: AffectState, params: AffectParams = DEFAULT_AFFECT_PARAMS) {
    this.current = state;
    this.params = params;
  }

  get state(): AffectState {
    return this.current;
  }

  enqueue(input: AffectInput): void {
    this.queue.push(input);
  }

  /** Apply every input due by `now`, then advance to `now`. Returns the state. */
  tick(now: number): AffectState {
    const { stepMs } = this.params;
    // Stable: equal times keep their arrival order.
    this.queue.sort((a, b) => a.at - b.at);
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next === undefined) break;
      const from = ms(this.current.updatedAt);
      const boundary = from + Math.max(0, Math.ceil((next.at - from) / stepMs)) * stepMs;
      if (boundary > now) break;
      this.queue.shift();
      this.current = applyAffectInput(advanceAffect(this.current, boundary, this.params), next, this.params);
    }
    this.current = advanceAffect(this.current, now, this.params);
    return this.current;
  }
}
