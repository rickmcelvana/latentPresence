import type { AffectReading, UserEmotion } from '@latentpresence/protocol';
import { USER_EMOTION_VA } from './user-text';

/**
 * Reading the user's face from MediaPipe's 52 blendshapes (P3-T06): pure arithmetic over
 * named scores, so it runs and is tested in node; the landmarker is a worker in
 * `packages/ml-web/src/face`, fusion is P3-T07's.
 *
 * **Three things, in order, and each is there because a face is not a label:**
 *
 * 1. **Against this person's own resting face.** A resting face is not all zeros: brows
 *    sit low on one person, a mouth turns down on another, and a camera from below changes
 *    both. Each feature keeps a baseline that follows it down quickly and up slowly, so it
 *    settles on the resting face in seconds and a smile held for a minute is still a smile.
 *    Only the rise above it counts.
 * 2. **Action units, not single shapes.** Each feeling is scored from the combination the
 *    Facial Action Coding System gives it — a smile with the cheeks raised, inner brows up
 *    with the mouth corners down — and a pattern that belongs to another feeling holds it
 *    back (a smile cancels anger and sadness). Surprise needs the brows: an open jaw alone
 *    is speech.
 * 3. **Over time.** The scores are smoothed over about half a second, because a face moves
 *    through expressions while it talks, and a frame is not a mood.
 *
 * The face is a weak witness and is weighted as one: confidence is capped at
 * `maxConfidence`, starts low until the baseline has settled, and falls to nothing when
 * the face is gone. It says nothing about situations and cannot see a straight face
 * hiding a feeling. Every number is in `DEFAULT_FACE_PARAMS`; `docs/affect.md` says why.
 */

/** The features read from the blendshapes: MediaPipe names, left and right averaged. */
export const FACE_FEATURES = {
  smile: ['mouthSmileLeft', 'mouthSmileRight'],
  cheekRaise: ['cheekSquintLeft', 'cheekSquintRight'],
  frown: ['mouthFrownLeft', 'mouthFrownRight'],
  browDown: ['browDownLeft', 'browDownRight'],
  browInnerUp: ['browInnerUp'],
  browOuterUp: ['browOuterUpLeft', 'browOuterUpRight'],
  eyeWide: ['eyeWideLeft', 'eyeWideRight'],
  jawOpen: ['jawOpen'],
  sneer: ['noseSneerLeft', 'noseSneerRight'],
  upperLip: ['mouthUpperUpLeft', 'mouthUpperUpRight'],
  press: ['mouthPressLeft', 'mouthPressRight'],
  stretch: ['mouthStretchLeft', 'mouthStretchRight'],
  chinRaise: ['mouthShrugLower'],
} as const;

export type FaceFeature = keyof typeof FACE_FEATURES;
export type FaceFeatures = Readonly<Record<FaceFeature, number>>;

/** The six a face can show; `neutral` is what is left when none of them is strong enough. */
export type FaceEmotion = Exclude<UserEmotion, 'neutral' | 'other' | 'unknown'>;
export const FACE_EMOTIONS: readonly FaceEmotion[] = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];

export interface FaceParams {
  /** How fast the baseline follows a feature down to a new resting value (ms time constant). */
  readonly baselineDownMs: number;
  /** How slowly it drifts up, so a held expression is not absorbed as rest. */
  readonly baselineUpMs: number;
  /** Seen for this long before full confidence: the baseline needs a moment to find the resting face. */
  readonly settleMs: number;
  /** Smoothing of the feeling scores (ms time constant). */
  readonly smoothingMs: number;
  /** No face for this long and the reading is gone. */
  readonly lostAfterMs: number;
  /** A feeling below this score leaves the face reading as neutral. */
  readonly threshold: number;
  /** The most a face reading is ever trusted. */
  readonly maxConfidence: number;
  /** How much a neutral face is believed to be calm, before `maxConfidence`. */
  readonly neutralConfidence: number;
}

export const DEFAULT_FACE_PARAMS: FaceParams = {
  baselineDownMs: 1500,
  baselineUpMs: 60_000,
  settleMs: 3000,
  smoothingMs: 500,
  lostAfterMs: 1000,
  threshold: 0.3,
  maxConfidence: 0.7,
  neutralConfidence: 0.4,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The features of one frame's blendshapes. A shape the model did not report counts as 0. */
export function faceFeatures(blendshapes: Readonly<Record<string, number>>): FaceFeatures {
  const out = {} as Record<FaceFeature, number>;
  for (const [feature, names] of Object.entries(FACE_FEATURES) as [FaceFeature, readonly string[]][]) {
    out[feature] = names.reduce((sum, name) => sum + (blendshapes[name] ?? 0), 0) / names.length;
  }
  return out;
}

/**
 * Each feeling's score, 0…1, from features that have already had the resting face taken
 * off. FACS in brief (Ekman and Friesen): happiness AU6+12, sadness AU1+4+15 (+17), anger
 * AU4+5+7+23, fear AU1+2+4+5+20, disgust AU9+10, surprise AU1+2+5+26.
 */
export function faceScores(d: FaceFeatures): Readonly<Record<FaceEmotion, number>> {
  // Inner brows raised more than the outer ones: the oblique brow of sadness and fear, not
  // the level lift of surprise.
  const innerOnly = Math.max(0, d.browInnerUp - d.browOuterUp);
  const browsUp = (d.browInnerUp + d.browOuterUp) / 2;
  const happy = clamp01(1.6 * d.smile + (d.smile > 0.15 ? 0.6 * d.cheekRaise : 0));
  const damp = 1 - happy;
  return {
    happy,
    // The chin raise (AU17) is in because MediaPipe barely reports the frown itself: on the
    // generated set's plainly sad faces `mouthFrown` rose ≤ 0.08, the chin up to 0.67.
    sad: clamp01((1.5 * d.frown + 1.2 * innerOnly + 1.5 * d.chinRaise) * damp),
    angry: clamp01((1.5 * d.browDown + 0.6 * d.press + 0.4 * d.sneer) * damp),
    fearful: clamp01((1.2 * d.eyeWide * Math.min(1, 3 * d.browInnerUp) + 1.2 * d.stretch) * damp),
    disgusted: clamp01((2 * d.sneer + d.upperLip) * damp),
    surprised: clamp01(browsUp > 0.1 ? 1.2 * browsUp + 0.8 * d.eyeWide + 0.5 * d.jawOpen : 0),
  };
}

/** A face reading, with the smoothed scores behind it — for tests and a debug overlay. */
export interface FaceReading extends AffectReading {
  readonly channel: 'face';
  readonly scores: Readonly<Record<FaceEmotion, number>>;
}

/**
 * One person's face over time. `push` a frame's blendshapes (or null for a frame with no
 * face) with its time; `reading` is null until a face has been seen, and again once it has
 * been gone for `lostAfterMs`.
 */
export class FaceAffectReader {
  private readonly params: FaceParams;
  private baseline: Record<FaceFeature, number> | null = null;
  private smoothed: Record<FaceEmotion, number> = { happy: 0, sad: 0, angry: 0, fearful: 0, disgusted: 0, surprised: 0 };
  private lastAt: number | null = null;
  private lastSeenAt: number | null = null;
  private seenMs = 0;

  constructor(params: Partial<FaceParams> = {}) {
    this.params = { ...DEFAULT_FACE_PARAMS, ...params };
  }

  push(blendshapes: Readonly<Record<string, number>> | null, at: number): FaceReading | null {
    const dt = this.lastAt === null ? 0 : Math.max(0, at - this.lastAt);
    this.lastAt = at;
    if (blendshapes === null) {
      // Lost: the scores fade towards nothing rather than holding the last expression.
      this.smoothed = this.smooth({ happy: 0, sad: 0, angry: 0, fearful: 0, disgusted: 0, surprised: 0 }, dt);
      return this.reading(at);
    }
    const features = faceFeatures(blendshapes);
    if (this.baseline === null || this.lastSeenAt === null || at - this.lastSeenAt > this.params.lostAfterMs) {
      // A face arriving (or back after a gap) settles again, from its own first frame.
      this.baseline ??= { ...features };
      this.seenMs = 0;
    } else {
      this.seenMs += dt;
    }
    const deviation = {} as Record<FaceFeature, number>;
    for (const feature of Object.keys(features) as FaceFeature[]) {
      const value = features[feature];
      const base = this.baseline[feature];
      const tau = value < base ? this.params.baselineDownMs : this.params.baselineUpMs;
      this.baseline[feature] = base + (value - base) * (1 - Math.exp(-dt / tau));
      deviation[feature] = Math.max(0, value - this.baseline[feature]);
    }
    this.smoothed = this.smooth(faceScores(deviation), dt);
    this.lastSeenAt = at;
    return this.reading(at);
  }

  /** The current reading without a new frame: null before a face and after it has gone. */
  reading(at: number): FaceReading | null {
    if (this.lastSeenAt === null || at - this.lastSeenAt > this.params.lostAfterMs) return null;
    const { threshold, maxConfidence, neutralConfidence, settleMs } = this.params;
    const settled = Math.min(1, this.seenMs / settleMs);
    const scores = { ...this.smoothed };
    let label: FaceEmotion | 'neutral' = 'neutral';
    let top = threshold;
    for (const emotion of FACE_EMOTIONS) {
      if (scores[emotion] >= top) {
        label = emotion;
        top = scores[emotion];
      }
    }
    // Where it sits: each feeling's point, weighted by its score, so a mixed face lands between.
    let valence = 0;
    let arousal = 0;
    for (const emotion of FACE_EMOTIONS) {
      valence += scores[emotion] * USER_EMOTION_VA[emotion].valence;
      arousal += scores[emotion] * USER_EMOTION_VA[emotion].arousal;
    }
    const total = FACE_EMOTIONS.reduce((sum, emotion) => sum + scores[emotion], 0);
    const norm = Math.max(1, total);
    const confidence =
      label === 'neutral' ? neutralConfidence * (1 - Math.max(...Object.values(scores))) : scores[label];
    return {
      channel: 'face',
      label,
      valence: valence / norm,
      arousal: arousal / norm,
      confidence: clamp01(confidence * maxConfidence * settled),
      scores,
    };
  }

  private smooth(target: Readonly<Record<FaceEmotion, number>>, dt: number): Record<FaceEmotion, number> {
    const k = dt === 0 ? 1 : 1 - Math.exp(-dt / this.params.smoothingMs);
    const out = {} as Record<FaceEmotion, number>;
    for (const emotion of FACE_EMOTIONS) out[emotion] = this.smoothed[emotion] + (target[emotion] - this.smoothed[emotion]) * k;
    return out;
  }
}
