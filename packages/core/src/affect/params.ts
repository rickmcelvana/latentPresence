import type { CharacterEmotion, Mood, SocialStance } from '@latentpresence/protocol';

/**
 * Every number the affect engine uses (P3-T01), in one place, as `DEFAULT_LIFE_PARAMS` is
 * for the life layer. **None of them is measured yet.** They are hand-set so the state
 * moves at a plausible pace — a flash of feeling in seconds, a mood over tens of minutes, a
 * week away back to the character's own baseline — and P3-T02's ten-state review is where
 * they meet a person. A persona can override the baseline (P3-T02 onward); nothing else
 * here is persona-shaped yet.
 */
export interface AffectParams {
  /** Where the character rests when nothing is happening. */
  readonly baseline: { readonly mood: Mood; readonly energy: number; readonly stance: SocialStance };
  /** How long a mood's distance from the baseline takes to halve, with nothing pushing it. */
  readonly moodHalfLifeMs: number;
  readonly energyHalfLifeMs: number;
  readonly stanceHalfLifeMs: number;
  /** An event's half-life when its input names none. */
  readonly eventHalfLifeMs: number;
  /** The longest half-life an event may have: it bounds how many steps a gap costs. */
  readonly maxEventHalfLifeMs: number;
  /** How hard one unit of feeling pulls the mood, per second, towards its PAD point. */
  readonly moodGainPerSecond: number;
  /** How hard one unit of feeling moves energy, per second, by the feeling's arousal. */
  readonly energyGainPerSecond: number;
  /** How hard one unit of feeling moves warmth and engagement, per second. */
  readonly stanceGainPerSecond: number;
  /** An event whose current intensity falls below this is dropped. */
  readonly negligible: number;
  /** Most events held at once; the weakest goes first. */
  readonly maxEvents: number;
  /** The fixed timestep. Inputs take effect on the first step boundary at or after them. */
  readonly stepMs: number;
  /** An `[emote:x]` tag's intensity: the model names a feeling but not how strongly. */
  readonly tagIntensity: number;
  /** How much of the user's apparent feeling the character catches (0 = none). */
  readonly empathy: number;
}

export const DEFAULT_AFFECT_PARAMS: AffectParams = {
  // Slightly content, slightly awake, neither leading nor led; warm, casual, attentive.
  baseline: {
    mood: { pleasure: 0.2, arousal: 0.05, dominance: 0 },
    energy: 0.6,
    stance: { warmth: 0.4, formality: -0.3, engagement: 0.3 },
  },
  moodHalfLifeMs: 20 * 60_000,
  energyHalfLifeMs: 15 * 60_000,
  stanceHalfLifeMs: 45 * 60_000,
  eventHalfLifeMs: 20_000,
  maxEventHalfLifeMs: 5 * 60_000,
  moodGainPerSecond: 0.03,
  energyGainPerSecond: 0.01,
  stanceGainPerSecond: 0.01,
  negligible: 0.02,
  maxEvents: 16,
  stepMs: 100,
  tagIntensity: 0.6,
  empathy: 0.5,
};

/**
 * Where each feeling pulls the mood, as pleasure, arousal, dominance. Hand-set in the
 * spirit of the PAD literature — joy pleasant and lively, sadness unpleasant and low,
 * embarrassment low in dominance, pride high — not transcribed from a table, and open to
 * P3-T02's review. `neutral` pulls nowhere.
 */
export const EMOTION_PAD: Readonly<Record<CharacterEmotion, Mood>> = {
  neutral: { pleasure: 0, arousal: 0, dominance: 0 },
  joy: { pleasure: 0.8, arousal: 0.5, dominance: 0.4 },
  affection: { pleasure: 0.7, arousal: 0.1, dominance: 0.1 },
  amusement: { pleasure: 0.7, arousal: 0.4, dominance: 0.3 },
  curiosity: { pleasure: 0.3, arousal: 0.5, dominance: 0.1 },
  surprise: { pleasure: 0.1, arousal: 0.8, dominance: -0.1 },
  concern: { pleasure: -0.4, arousal: 0.3, dominance: -0.2 },
  sadness: { pleasure: -0.6, arousal: -0.4, dominance: -0.4 },
  frustration: { pleasure: -0.6, arousal: 0.6, dominance: 0.2 },
  embarrassment: { pleasure: -0.3, arousal: 0.4, dominance: -0.6 },
  pride: { pleasure: 0.6, arousal: 0.3, dominance: 0.7 },
  relief: { pleasure: 0.5, arousal: -0.4, dominance: 0.1 },
};

/** Where each feeling pushes warmth and engagement. Formality moves only when told to. */
export const EMOTION_STANCE: Readonly<Record<CharacterEmotion, { readonly warmth: number; readonly engagement: number }>> = {
  neutral: { warmth: 0, engagement: 0 },
  joy: { warmth: 0.4, engagement: 0.4 },
  affection: { warmth: 0.8, engagement: 0.4 },
  amusement: { warmth: 0.4, engagement: 0.3 },
  curiosity: { warmth: 0.1, engagement: 0.8 },
  surprise: { warmth: 0, engagement: 0.5 },
  concern: { warmth: 0.5, engagement: 0.5 },
  sadness: { warmth: 0.1, engagement: -0.4 },
  frustration: { warmth: -0.5, engagement: 0 },
  embarrassment: { warmth: 0, engagement: -0.4 },
  pride: { warmth: 0.1, engagement: 0.2 },
  relief: { warmth: 0.3, engagement: -0.1 },
};
