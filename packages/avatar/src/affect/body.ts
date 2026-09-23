import type {
  CharacterEmotion,
  CharacterGesture,
  ExpressionName,
  ExpressionWeights,
  GazeTarget,
  Mood,
  SocialStance,
} from '@latentpresence/protocol';
import type { MoodParams } from '../life/params';
import { EMOTION_EXPRESSIONS } from '../mappings/emotions';
import { affectRegion, regionStrength, type AffectRegion } from './regions';

/**
 * What `affectToBody` needs, assembled by whatever page holds the affect engine
 * (`packages/core/src/affect`). `packages/avatar` depends on protocol only, so this is
 * plain data rather than a reference to `AffectState` or `AffectEngine`.
 */
export interface AffectInputs {
  readonly mood: Mood;
  readonly energy: number;
  readonly stance: SocialStance;
  /** The strongest current feeling — the page gets it from core's `dominantEmotion`. */
  readonly feeling: { readonly label: CharacterEmotion; readonly intensity: number };
}

/**
 * Multipliers on the life layer's per-state `MoodParams` (`modulateMood`); 1 everywhere is
 * unchanged. `blinkScale` scales the *mean interval between blinks* — above 1 means
 * fewer, slower blinks, below 1 means more, faster ones, the inverse of a blink rate.
 * `awayTargets`, when present, replaces the state's own list rather than weighting it.
 */
export interface GazeModulation {
  readonly lookAwayScale: number;
  readonly holdScale: number;
  readonly awayMeanScale: number;
  readonly blinkScale: number;
  readonly breathScale: number;
  readonly awayTargets?: readonly Exclude<GazeTarget, 'user'>[];
}

/** No change to the state's own gaze habit — every multiplier at 1, no target override. */
const IDENTITY_GAZE: GazeModulation = {
  lookAwayScale: 1,
  holdScale: 1,
  awayMeanScale: 1,
  blinkScale: 1,
  breathScale: 1,
};

/** One region's resting body: a face, a gaze habit, the gestures it reaches for, an idle clip. */
export interface RegionBody {
  /** A resting face at full strength — every weight ≤ 0.35, so the emote on top of it
   * (`EMOTION_EXPRESSIONS`) is still the strong one. `neutral`'s is empty. */
  readonly face: ExpressionWeights;
  readonly gaze: GazeModulation;
  /** Most fitting first; the performable ones (`GESTURE_MOTIONS[g] !== null`) before any
   * that still need a clip. */
  readonly gestureBias: readonly CharacterGesture[];
  /** The clip id this region would idle on if the pack had it — `affectToBody` falls back
   * to whatever is actually loaded. */
  readonly idleClip: string;
}

/**
 * The resting body for each PAD octant (`affectRegion`), hand-set like the rest of the
 * affect engine's numbers — P3-T02's ten-state review is where they meet a person.
 */
export const REGION_BODY: Readonly<Record<AffectRegion, RegionBody>> = {
  // Nothing in particular: the state with no face and no habit of its own.
  neutral: {
    face: {},
    gaze: IDENTITY_GAZE,
    gestureBias: ['nod', 'tilt-head'],
    idleClip: 'idle',
  },
  // Pleasant, aroused, dominant: happy and sure of itself. A light, open smile — the
  // strong `happy` belongs to the emote riding on top, this is just the resting glow.
  // Holds the user's eyes rather than glancing off; blinks a touch faster, breathes a
  // touch faster — both read as lively rather than calm.
  exuberant: {
    face: { happy: 0.3 },
    gaze: { lookAwayScale: 0.7, holdScale: 1.4, awayMeanScale: 1, blinkScale: 0.9, breathScale: 1.1 },
    gestureBias: ['nod', 'open-hands', 'wave'],
    idleClip: 'idle-bright',
  },
  // Pleasant, aroused, submissive: eager to please rather than sure of itself — a softer
  // smile than exuberant's, brows up a little the way an eager listener's do. Leans in
  // more than it holds still.
  dependent: {
    face: { happy: 0.2, browInnerUp: 0.15 },
    gaze: { lookAwayScale: 0.8, holdScale: 1.1, awayMeanScale: 0.8, blinkScale: 0.85, breathScale: 1.05 },
    gestureBias: ['nod', 'lean-in', 'tilt-head'],
    idleClip: 'idle-bright',
  },
  // Pleasant, calm, dominant: comfortable and in no hurry — the VRM `relaxed` preset was
  // built for exactly this. Long, unhurried holds and slow, deep breathing.
  relaxed: {
    face: { relaxed: 0.3 },
    gaze: { lookAwayScale: 0.9, holdScale: 1.2, awayMeanScale: 1.1, blinkScale: 1.2, breathScale: 0.9 },
    gestureBias: ['tilt-head', 'lean-in', 'nod'],
    idleClip: 'idle-low',
  },
  // Pleasant, calm, submissive: content without asserting anything — mostly `relaxed`
  // with a touch of `happy`, both turned down further than the region above. Looks down
  // more than it looks away outright: agreeable, not withdrawn.
  docile: {
    face: { relaxed: 0.2, happy: 0.1 },
    gaze: {
      lookAwayScale: 1.3,
      holdScale: 0.9,
      awayMeanScale: 1.1,
      blinkScale: 1.1,
      breathScale: 0.85,
      awayTargets: ['down', 'down', 'away'],
    },
    gestureBias: ['nod', 'tilt-head'],
    idleClip: 'idle-low',
  },
  // Unpleasant, aroused, dominant: confrontational. Brows down and a hard set to the
  // mouth, well short of the emote's own full `angry`. Holds a challenging stare rather
  // than looking away; breathes faster, the way agitation does.
  hostile: {
    face: { angry: 0.25 },
    gaze: { lookAwayScale: 0.7, holdScale: 1.3, awayMeanScale: 0.7, blinkScale: 0.8, breathScale: 1.2 },
    gestureBias: ['shake-head', 'shrug'],
    idleClip: 'idle-tense',
  },
  // Unpleasant, aroused, submissive: worried rather than confrontational — the brows
  // pull up and in, with sadness underneath. Skitters away and back, and blinks fast.
  // `sad` carries it on a preset-only model, where the brows do nothing (the placeholder).
  anxious: {
    face: { browInnerUp: 0.3, sad: 0.2 },
    gaze: {
      lookAwayScale: 1.5,
      holdScale: 0.7,
      awayMeanScale: 0.8,
      blinkScale: 0.7,
      breathScale: 1.25,
      awayTargets: ['away', 'away', 'wander'],
    },
    gestureBias: ['shake-head', 'shrug', 'tilt-head'],
    idleClip: 'idle-tense',
  },
  // Unpleasant, calm, dominant: cold and unimpressed rather than confrontational —
  // narrowed eyes and a slight frown, none of hostile's arousal. Looks away for long,
  // unhurried stretches, as if not bothering to watch; blinks slow. A little `angry` so a
  // preset-only model (no squint; frown falls back to half-`sad`) still shows the chill.
  disdainful: {
    face: { eyeSquint: 0.2, mouthFrown: 0.1, angry: 0.12 },
    gaze: { lookAwayScale: 1.2, holdScale: 1.1, awayMeanScale: 1.3, blinkScale: 1.15, breathScale: 0.9 },
    gestureBias: ['shrug', 'shake-head'],
    idleClip: 'idle-low',
  },
  // Unpleasant, calm, submissive: flat and disengaged — the closest region to switched
  // off. Looks away often and for a long time, mostly down; blinks slow, breathes slow.
  bored: {
    face: { sad: 0.15, relaxed: 0.1 },
    gaze: {
      lookAwayScale: 1.4,
      holdScale: 0.8,
      awayMeanScale: 1.4,
      blinkScale: 1.3,
      breathScale: 0.8,
      awayTargets: ['down', 'down', 'wander'],
    },
    gestureBias: ['shrug', 'tilt-head'],
    idleClip: 'idle-low',
  },
};

/** What `affectToBody` resolves an `AffectInputs` down to for the rest of the avatar. */
export interface AffectBody {
  readonly region: AffectRegion;
  readonly strength: number;
  /** What the face should rest at, before any tag's expression rides on top. */
  readonly expression: ExpressionWeights;
  /** Identity at strength 0, energy 0.5, engagement ≤ 0. */
  readonly gaze: GazeModulation;
  readonly gestureBias: readonly CharacterGesture[];
  /** Always one of the clip ids passed in. */
  readonly idleClip: string;
  /** The table's own choice, so a panel can show when it fell back. */
  readonly idleClipWanted: string;
}

/** Every output expression weight is capped here, whatever the region and the feeling add
 * up to. */
const EXPRESSION_CAP = 0.8;

/**
 * How stance and energy nudge the region's gaze multipliers, on top of `strength`. Named
 * and commented so the numbers read as a policy rather than something buried in an
 * expression: at energy 0.5 both are exactly 1, which is what keeps the identity gaze
 * truly the identity at rest.
 */
const GAZE_ADJUST = {
  /** Engaged → looks away less: each unit of positive engagement cuts `lookAwayScale` by
   * this share. */
  engagementLookAwayShare: 0.4,
  /** `breathScale *= breathBase + breathEnergyGain × energy`. */
  breathBase: 0.85,
  breathEnergyGain: 0.3,
  /** `blinkScale *= blinkBase − blinkEnergyLoss × energy` (higher energy → a shorter mean
   * interval → a lower scale). */
  blinkBase: 1.15,
  blinkEnergyLoss: 0.3,
} as const;

function scaled(weights: ExpressionWeights, by: number): ExpressionWeights {
  const out: Partial<Record<ExpressionName, number>> = {};
  for (const [name, weight] of Object.entries(weights) as [ExpressionName, number][]) out[name] = weight * by;
  return out;
}

/** Per-name max of two expressions, each weight capped at `cap`. A weight of exactly 0 is
 * dropped rather than kept, so a name neither side touched never appears. */
function mergedMax(a: ExpressionWeights, b: ExpressionWeights, cap: number): ExpressionWeights {
  const names = new Set([...Object.keys(a), ...Object.keys(b)] as ExpressionName[]);
  const out: Partial<Record<ExpressionName, number>> = {};
  for (const name of names) {
    const value = Math.min(cap, Math.max(a[name] ?? 0, b[name] ?? 0));
    if (value > 0) out[name] = value;
  }
  return out;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** The region's gaze at `strength`: every multiplier eased from 1 towards the table's own
 * value, and `awayTargets` only once the region is more than half in charge. `exactOptionalPropertyTypes`
 * means the key has to be left out rather than set to `undefined`. */
function lerpedGaze(region: GazeModulation, strength: number): GazeModulation {
  const eased = {
    lookAwayScale: lerp(1, region.lookAwayScale, strength),
    holdScale: lerp(1, region.holdScale, strength),
    awayMeanScale: lerp(1, region.awayMeanScale, strength),
    blinkScale: lerp(1, region.blinkScale, strength),
    breathScale: lerp(1, region.breathScale, strength),
  };
  return strength >= 0.5 && region.awayTargets !== undefined
    ? { ...eased, awayTargets: region.awayTargets }
    : eased;
}

/** Stance and energy on top of the region's gaze. */
function adjustedGaze(gaze: GazeModulation, stance: SocialStance, energy: number): GazeModulation {
  return {
    ...gaze,
    lookAwayScale: gaze.lookAwayScale * (1 - GAZE_ADJUST.engagementLookAwayShare * Math.max(0, stance.engagement)),
    breathScale: gaze.breathScale * (GAZE_ADJUST.breathBase + GAZE_ADJUST.breathEnergyGain * energy),
    blinkScale: gaze.blinkScale * (GAZE_ADJUST.blinkBase - GAZE_ADJUST.blinkEnergyLoss * energy),
  };
}

/** `lean-in` first once engagement is over half, wherever it sat — or did not sit — in
 * the region's own list. */
function biasedGestures(bias: readonly CharacterGesture[], engagement: number): readonly CharacterGesture[] {
  if (engagement <= 0.5 || bias[0] === 'lean-in') return bias;
  return ['lean-in', ...bias.filter((gesture) => gesture !== 'lean-in')];
}

/**
 * The one pure function from affect to body (P3-T02): a region and how far into it the
 * mood sits (`affectRegion`/`regionStrength`), a resting face merged with the current
 * feeling, a gaze modulation, a gesture bias and an idle clip that always resolves to
 * something actually loaded.
 */
export function affectToBody(inputs: AffectInputs, availableClips: readonly string[] = ['idle']): AffectBody {
  const region = affectRegion(inputs.mood);
  const strength = regionStrength(inputs.mood);
  const body = REGION_BODY[region];

  const expression = mergedMax(
    scaled(body.face, strength),
    scaled(EMOTION_EXPRESSIONS[inputs.feeling.label], inputs.feeling.intensity),
    EXPRESSION_CAP,
  );
  const gaze = adjustedGaze(lerpedGaze(body.gaze, strength), inputs.stance, inputs.energy);
  const gestureBias = biasedGestures(body.gestureBias, inputs.stance.engagement);

  const idleClipWanted = body.idleClip;
  const idleClip = availableClips.includes(idleClipWanted) ? idleClipWanted : (availableClips[0] ?? idleClipWanted);

  return { region, strength, expression, gaze, gestureBias, idleClip, idleClipWanted };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * `LifeLayer`'s per-state `MoodParams` with a `GazeModulation` multiplied on top, clamped
 * to what the rest of the life layer assumes always holds: `lookAwayChance` a probability
 * under 0.95 (never *always* away), every duration at least 300 ms (nothing schedules a
 * decision on top of itself), `breathsPerMinute` inside a human range.
 */
export function modulateMood(base: MoodParams, gaze: GazeModulation): MoodParams {
  return {
    breathsPerMinute: clamp(base.breathsPerMinute * gaze.breathScale, 6, 30),
    blinkMeanMs: Math.max(300, base.blinkMeanMs * gaze.blinkScale),
    lookAwayChance: clamp(base.lookAwayChance * gaze.lookAwayScale, 0, 0.95),
    holdMeanMs: Math.max(300, base.holdMeanMs * gaze.holdScale),
    awayMeanMs: Math.max(300, base.awayMeanMs * gaze.awayMeanScale),
    awayTargets: gaze.awayTargets ?? base.awayTargets,
  };
}
