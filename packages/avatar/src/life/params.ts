import type { ConversationState, GazeTarget } from '@latentpresence/protocol';

/**
 * Every number the life layer uses, in one place, per conversation state.
 *
 * "All parameterised" is the plan's word, and it matters more than any one value: these
 * are **starting points to be tuned by eye**, not measurements. P2-T02's done-when is a
 * person watching a minute of recording, so the dials have to be reachable without
 * reading the code that uses them.
 *
 * Where a value comes from the literature on conversational behaviour it says so, as a
 * range rather than a citation — the ranges are broad and well known (resting blink rate
 * ~15–20 a minute and higher in conversation; a listener looks at the speaker most of the
 * time, a speaker looks away more), and the exact figure is a matter of taste.
 */
export interface MoodParams {
  /** Breaths per minute. Resting adults are ~12–20. */
  readonly breathsPerMinute: number;
  /** Mean time between blinks, ms. 3000 ≈ 20 a minute. */
  readonly blinkMeanMs: number;
  /** Share of glance decisions that leave the base target (0 = always on it). */
  readonly lookAwayChance: number;
  /** How long a look at the base target lasts before the next decision, ms (mean). */
  readonly holdMeanMs: number;
  /** How long a look away lasts, ms (mean). */
  readonly awayMeanMs: number;
  /** Where a look away goes, drawn evenly; repeat a target to weight it. */
  readonly awayTargets: readonly Exclude<GazeTarget, 'user'>[];
}

export interface LifeParams {
  readonly moods: Readonly<Record<ConversationState, MoodParams>>;

  readonly breathing: {
    /** Share of a breath spent inhaling; the rest is the slower exhale. */
    readonly inhaleShare: number;
    /** Chest and upper-chest pitch at full inhale, radians. */
    readonly chestPitch: number;
    /** Shoulder lift at full inhale, radians. */
    readonly shoulderLift: number;
  };

  readonly blink: {
    readonly closeMs: number;
    readonly holdMs: number;
    readonly openMs: number;
    /** Chance a blink is immediately followed by a second. */
    readonly doubleChance: number;
    /** Chance a large gaze shift carries a blink with it. */
    readonly withSaccadeChance: number;
    /** No blink starts sooner than this after the last one ended. */
    readonly refractoryMs: number;
  };

  readonly gaze: {
    /** While on the base target, the eyes hop between nearby points (face features). */
    readonly fixationHopMeanMs: number;
    /** How far those hops go, metres at the target: an eye, the other eye, the mouth. */
    readonly fixationRadius: number;
    /** How far off-axis a look away lands on top of its target's own direction, metres. */
    readonly awayJitter: number;
    /** How much of the eyes' turn the head follows. 0 = eyes only. */
    readonly headFollow: number;
    /** Time constant of the head catching up with the eyes, ms. */
    readonly headLagMs: number;
  };

  readonly weightShift: {
    /** Mean time between shifts of stance, ms. */
    readonly meanMs: number;
    /** How long a shift takes, ms. */
    readonly durationMs: number;
    /** Sideways hip travel of a shift, metres (each side of centre). */
    readonly hipTravel: number;
    /** Hip roll that goes with it, radians; the spine counter-rolls by the same. */
    readonly hipRoll: number;
    /** A slow sway under everything, radians of spine roll, and its period in ms. */
    readonly swayRoll: number;
    readonly swayPeriodMs: number;
  };

  /**
   * Arms down from the T-pose a VRM is authored in. Radians of upper-arm roll and elbow
   * bend. Applied only while no clip is playing: a clip brings its own arms (P2-T03).
   */
  readonly rest: {
    readonly upperArmDrop: number;
    readonly elbowBend: number;
  };
}

const LISTENING: MoodParams = {
  breathsPerMinute: 14,
  blinkMeanMs: 3400,
  lookAwayChance: 0.25,
  holdMeanMs: 3200,
  awayMeanMs: 900,
  awayTargets: ['wander', 'wander', 'away', 'down'],
};

export const DEFAULT_LIFE_PARAMS: LifeParams = {
  moods: {
    idle: {
      breathsPerMinute: 12,
      blinkMeanMs: 3800,
      lookAwayChance: 0.45,
      holdMeanMs: 2600,
      awayMeanMs: 1800,
      awayTargets: ['wander', 'away', 'screen', 'down'],
    },
    listening: LISTENING,
    // Thinking looks away more and for longer, and blinks less (attention turned inward).
    thinking: {
      breathsPerMinute: 13,
      blinkMeanMs: 4600,
      lookAwayChance: 0.7,
      holdMeanMs: 1200,
      awayMeanMs: 1600,
      awayTargets: ['away', 'away', 'down'],
    },
    // A speaker looks away more than a listener and blinks more.
    speaking: {
      breathsPerMinute: 16,
      blinkMeanMs: 2600,
      lookAwayChance: 0.45,
      holdMeanMs: 2200,
      awayMeanMs: 1100,
      awayTargets: ['wander', 'away', 'away', 'down'],
    },
    // A barge-in hands the floor back: the face goes straight to listening.
    interrupted: LISTENING,
  },
  breathing: { inhaleShare: 0.4, chestPitch: 0.018, shoulderLift: 0.022 },
  blink: {
    closeMs: 70,
    holdMs: 40,
    openMs: 140,
    doubleChance: 0.08,
    withSaccadeChance: 0.5,
    refractoryMs: 450,
  },
  gaze: {
    fixationHopMeanMs: 900,
    fixationRadius: 0.035,
    awayJitter: 0.12,
    headFollow: 0.3,
    headLagMs: 220,
  },
  weightShift: {
    meanMs: 14_000,
    durationMs: 1600,
    hipTravel: 0.012,
    hipRoll: 0.025,
    swayRoll: 0.006,
    swayPeriodMs: 7000,
  },
  rest: { upperArmDrop: 1.2, elbowBend: 0.25 },
};
