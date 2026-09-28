import type { CharacterGesture, ConversationEvent, ConversationState, ExpressionName, ExpressionWeights, UserAffect, UserEmotion } from '@latentpresence/protocol';
import { mergeExpressionsMax } from '../affect/body';

/**
 * How she listens (P3-T08): her face and head while the user talks, keyed to how they seem
 * (P3-T07's live fused estimate) and to how they talk — where they pause and how loud they
 * get. Pure and stepped by the caller's clock, like `LifeLayer` and `CuePerformer`.
 *
 * **The rule is that a reaction never contradicts the user's tone**, because that is the
 * plan's done-when and because a wrong reaction is far worse than none. So:
 *
 * - **She follows, she does not mirror.** A happy user gets a soft smile; a sad or frightened
 *   one gets concern; an angry or disgusted one gets a serious, concerned face — never anger
 *   back, and never a smile. D-36 found sad faces reading as angry, so the two reactions are
 *   deliberately the same family: a misread between them still lands on concern.
 * - **Doubt is neutral.** Below `minConfidence` she is simply attentive; the reaction scales
 *   up to full at `fullConfidence`. A label whose valence points the other way (a "happy"
 *   with negative valence) is doubt too.
 * - **A label must hold `settleMs`** before her face follows it, so a flicker in the face
 *   reader does not become a flicker in hers.
 * - **Her own mood gives way.** The resting face from her affect (P3-T09) can be a glow or a
 *   frown of her own; while she listens, the parts of it that would contradict the user are
 *   damped (`damp`), so a bright mood does not smile at someone upset.
 *
 * **Prosody:** a pause Smart Turn judged *unfinished* (under the turn threshold) after enough
 * speech gets a nod — a tilt for someone sad — at most one per `gestureIntervalMs`; a spoken
 * backchannel (ADR-28) always brings a nod with it. Loudness against the speaker's own running
 * level is *emphasis*, which strengthens the reaction a little and lifts her brows for good
 * news. The backchannel word itself is chosen to fit (`phrases`).
 */

export interface ListeningParams {
  readonly minConfidence: number;
  readonly fullConfidence: number;
  readonly settleMs: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  /** Smart Turn at or over this is a turn end, not a pause (`DEFAULT_TURN_THRESHOLD` in core). */
  readonly pauseThreshold: number;
  /** Speech in the turn before a pause may be nodded at. */
  readonly minSpeechMs: number;
  readonly gestureIntervalMs: number;
  /** A backchannel's nod is skipped if a gesture started this recently (the same pause). */
  readonly backchannelNodGapMs: number;
  /** Frames quieter than this are not speech, for the loudness baseline. */
  readonly levelFloorDb: number;
  readonly baselineTauMs: number;
  readonly shortTauMs: number;
  /** Emphasis starts this many dB over the speaker's baseline and is full `emphasisRangeDb` later. */
  readonly emphasisDb: number;
  readonly emphasisRangeDb: number;
}

export const DEFAULT_LISTENING_PARAMS: ListeningParams = {
  minConfidence: 0.1,
  fullConfidence: 0.4,
  settleMs: 600,
  attackMs: 400,
  releaseMs: 900,
  pauseThreshold: 0.7,
  minSpeechMs: 1500,
  gestureIntervalMs: 3500,
  backchannelNodGapMs: 1000,
  levelFloorDb: -50,
  baselineTauMs: 8000,
  shortTauMs: 250,
  emphasisDb: 4,
  emphasisRangeDb: 6,
};

/** The kind of reaction a user label gets. */
export type ListeningReaction = 'attentive' | 'warm' | 'surprised' | 'concern' | 'serious';

const REACTION_OF: Readonly<Record<UserEmotion, ListeningReaction>> = {
  neutral: 'attentive',
  happy: 'warm',
  surprised: 'surprised',
  sad: 'concern',
  fearful: 'concern',
  angry: 'serious',
  disgusted: 'serious',
  other: 'attentive',
  unknown: 'attentive',
};

interface ReactionFace {
  /** Her face at full strength, max-merged over her own. */
  readonly face: ExpressionWeights;
  /** Multipliers on her own resting face at full strength; a name not listed is untouched. */
  readonly damp: Partial<Record<ExpressionName, number>>;
  /** The sign valence must have for this reaction to be believed; 0 accepts either. */
  readonly valence: -1 | 0 | 1;
}

/**
 * Weights stay under the emotes' (`EMOTION_EXPRESSIONS`): this is a listener's face, held for
 * as long as the user talks, not a line's punctuation. Concern is `concern`'s brows with less
 * `sad`; serious is less again — attentive and grave, not hurt.
 */
export const LISTENING_FACES: Readonly<Record<ListeningReaction, ReactionFace>> = {
  attentive: { face: {}, damp: {}, valence: 0 },
  warm: { face: { happy: 0.35, relaxed: 0.1 }, damp: { angry: 0, sad: 0, mouthFrown: 0, eyeSquint: 0.5 }, valence: 1 },
  surprised: { face: { surprised: 0.25, browInnerUp: 0.2 }, damp: { angry: 0 }, valence: 0 },
  concern: { face: { sad: 0.3, browInnerUp: 0.45 }, damp: { happy: 0, relaxed: 0.3, angry: 0 }, valence: -1 },
  serious: { face: { sad: 0.15, browInnerUp: 0.3 }, damp: { happy: 0, relaxed: 0.3, angry: 0 }, valence: -1 },
};

/**
 * The backchannel words that fit each reaction, from P1-T09's set. Soft ones for someone sad
 * ("Yes." and "Right." can sound brisk), no "Oh." for someone angry (it can sound surprised at
 * them), "Oh." for news. `attentive` has no preference.
 */
export const LISTENING_PHRASES: Readonly<Record<ListeningReaction, readonly string[] | null>> = {
  attentive: null,
  warm: ['Yeah.', 'Yes.', 'Right.'],
  surprised: ['Oh.'],
  concern: ['Oh.', 'Yeah.'],
  serious: ['Right.', 'Yeah.'],
};

export interface ListeningFrame {
  /** Her listening face, to max-merge over her own (`applyListening`). */
  readonly expression: ExpressionWeights;
  /** Multipliers on her own face; a name not listed is 1. */
  readonly damp: Partial<Record<ExpressionName, number>>;
  /** Gestures to start this frame. */
  readonly gestures: readonly CharacterGesture[];
}

export interface ListeningStatus {
  readonly reaction: ListeningReaction;
  /** 0–1: how sure, from the fused confidence. */
  readonly strength: number;
  /** 0–1: how loud against the speaker's own level, just now. */
  readonly emphasis: number;
  readonly active: boolean;
}

/** Her own face with the listening frame applied: damped where it would contradict, then the reaction over it. */
export function applyListening(face: ExpressionWeights, frame: ListeningFrame): ExpressionWeights {
  const damped: Partial<Record<ExpressionName, number>> = {};
  for (const [name, weight] of Object.entries(face) as [ExpressionName, number][]) {
    const scaled = weight * (frame.damp[name] ?? 1);
    if (scaled > 0) damped[name] = scaled;
  }
  return mergeExpressionsMax(damped, frame.expression);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class ListeningReactor {
  private readonly params: ListeningParams;
  private state: ConversationState = 'idle';
  private turn: { readonly startAt: number; open: boolean } | null = null;
  private lastGestureAt = Number.NEGATIVE_INFINITY;
  private queued: CharacterGesture[] = [];

  private settled: ListeningReaction = 'attentive';
  private candidate: { reaction: ListeningReaction; since: number } | null = null;
  private strength = 0;

  private baselineDb: number | null = null;
  private shortDb: number | null = null;
  private lastLevelAt: number | null = null;

  private face: Partial<Record<ExpressionName, number>> = {};
  private damp: Partial<Record<ExpressionName, number>> = {};
  private lastUpdateAt: number | null = null;

  constructor(params: ListeningParams = DEFAULT_LISTENING_PARAMS) {
    this.params = params;
  }

  /** She reacts only while the floor is the user's. */
  get active(): boolean {
    return this.state === 'listening';
  }

  /** Where the conversation is, for a reactor that joins it late (it follows `state.changed` from then on). */
  setState(state: ConversationState): void {
    this.state = state;
  }

  /** A conversation event, on the same clock as `update`. */
  onEvent(event: ConversationEvent, now: number): void {
    switch (event.type) {
      case 'state.changed':
        this.state = event.to;
        return;
      case 'user.speech.started':
        this.turn = { startAt: now, open: true };
        return;
      case 'user.turn.resumed':
        if (this.turn !== null) this.turn.open = true;
        return;
      case 'user.speech.ended':
        if (this.turn !== null) this.turn.open = false;
        return;
      case 'assistant.backchannel':
        // The word and the nod together; a pause that already nodded keeps its one gesture.
        if (now - this.lastGestureAt >= this.params.backchannelNodGapMs) this.gesture('nod', now);
        return;
      default:
    }
  }

  /** Smart Turn's answer on a pause, from the call. Under the threshold means *not finished*. */
  pause(probability: number, now: number): void {
    const { params } = this;
    if (!this.active || probability >= params.pauseThreshold) return;
    const turn = this.turn;
    if (turn === null || !turn.open || now - turn.startAt < params.minSpeechMs) return;
    if (now - this.lastGestureAt < params.gestureIntervalMs) return;
    this.gesture(this.settled === 'concern' && this.strength >= 0.5 ? 'tilt-head' : 'nod', now);
  }

  /** One microphone frame's RMS, from the call. */
  level(rms: number, now: number): void {
    const { params } = this;
    const db = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
    const dt = this.lastLevelAt === null ? 0 : Math.max(0, now - this.lastLevelAt);
    this.lastLevelAt = now;
    if (db < params.levelFloorDb) {
      // Silence says nothing about emphasis; let the short level fall to the baseline.
      if (this.shortDb !== null && this.baselineDb !== null) this.shortDb += (this.baselineDb - this.shortDb) * (1 - Math.exp(-dt / params.shortTauMs));
      return;
    }
    this.shortDb = this.shortDb === null ? db : this.shortDb + (db - this.shortDb) * (1 - Math.exp(-dt / params.shortTauMs));
    this.baselineDb = this.baselineDb === null ? db : this.baselineDb + (db - this.baselineDb) * (1 - Math.exp(-dt / params.baselineTauMs));
  }

  /** 0–1: how far over their own level the speaker is right now. */
  emphasis(): number {
    if (this.shortDb === null || this.baselineDb === null) return 0;
    return clamp01((this.shortDb - this.baselineDb - this.params.emphasisDb) / this.params.emphasisRangeDb);
  }

  /** The backchannel words that fit now, or null for any. */
  phrases(): readonly string[] | null {
    return this.active && this.strength > 0 ? LISTENING_PHRASES[this.settled] : null;
  }

  status(): ListeningStatus {
    return { reaction: this.settled, strength: this.strength, emphasis: this.emphasis(), active: this.active };
  }

  /** One frame. `user` is the live fused estimate (P3-T07's `current`), or null. */
  update(now: number, user: UserAffect | null): ListeningFrame {
    const { params } = this;
    const delta = this.lastUpdateAt === null ? 0 : Math.max(0, now - this.lastUpdateAt);
    this.lastUpdateAt = now;
    this.settle(now, user);

    const reaction = LISTENING_FACES[this.settled];
    const amount = this.active ? this.strength : 0;
    const emphasis = this.emphasis();
    const lift = 0.75 + 0.25 * emphasis;
    const faceTarget: Partial<Record<ExpressionName, number>> = {};
    for (const [name, weight] of Object.entries(reaction.face) as [ExpressionName, number][]) faceTarget[name] = weight * amount * lift;
    if (this.settled === 'warm' || this.settled === 'surprised') faceTarget.browInnerUp = Math.max(faceTarget.browInnerUp ?? 0, 0.15 * emphasis * amount);
    const dampTarget: Partial<Record<ExpressionName, number>> = {};
    for (const [name, factor] of Object.entries(reaction.damp) as [ExpressionName, number][]) dampTarget[name] = 1 - amount * (1 - factor);

    this.face = ease(this.face, faceTarget, 0, delta, params);
    this.damp = ease(this.damp, dampTarget, 1, delta, params);
    const gestures = this.queued;
    this.queued = [];
    return { expression: { ...this.face }, damp: { ...this.damp }, gestures };
  }

  private settle(now: number, user: UserAffect | null): void {
    const { params } = this;
    let reaction: ListeningReaction = 'attentive';
    let strength = 0;
    if (user !== null && user.confidence >= params.minConfidence) {
      const wanted = REACTION_OF[user.label];
      const sign = LISTENING_FACES[wanted].valence;
      // A label whose valence points the other way is doubt, and doubt is neutral.
      if (sign === 0 || Math.sign(user.valence) === sign) {
        reaction = wanted;
        strength = clamp01((user.confidence - params.minConfidence) / (params.fullConfidence - params.minConfidence));
      }
    }
    if (reaction === 'attentive') strength = 0;
    if (reaction === this.settled) {
      this.candidate = null;
      this.strength = strength;
      return;
    }
    if (this.candidate?.reaction !== reaction) this.candidate = { reaction, since: now };
    if (now - this.candidate.since >= params.settleMs) {
      this.settled = reaction;
      this.strength = strength;
      this.candidate = null;
    } else {
      // The old reaction lets go while the new one proves itself: a smile does not wait out
      // `settleMs` at someone who has just turned sad.
      this.strength = 0;
    }
  }

  private gesture(gesture: CharacterGesture, now: number): void {
    this.queued.push(gesture);
    this.lastGestureAt = now;
  }
}

/** Each weight toward its target: fast in, slower out, like `CuePerformer`. `rest` is the value a name missing from both has. */
function ease(
  current: Partial<Record<ExpressionName, number>>,
  target: Partial<Record<ExpressionName, number>>,
  rest: number,
  delta: number,
  params: ListeningParams,
): Partial<Record<ExpressionName, number>> {
  const names = new Set([...Object.keys(current), ...Object.keys(target)] as ExpressionName[]);
  const next: Partial<Record<ExpressionName, number>> = {};
  for (const name of names) {
    const from = current[name] ?? rest;
    const to = target[name] ?? rest;
    // Moving away from rest is the reaction arriving; toward it, leaving.
    const tau = Math.abs(to - rest) > Math.abs(from - rest) ? params.attackMs : params.releaseMs;
    const value = delta === 0 ? from : from + (to - from) * (1 - Math.exp(-delta / tau));
    if (Math.abs(value - rest) > 0.005 || Math.abs(to - rest) > 0) next[name] = value;
  }
  return next;
}
