import type { AffectReading, ConversationEvent, UserAffect, UserEmotion } from '@latentpresence/protocol';
import { MessagePace, readUserText, readingFromTag } from './user-text';

/**
 * How the user seems, from every channel at once (P3-T07): the text heuristic (P3-T04), the
 * model's `[user:x]` (ADR-32), their voice (P3-T05) and their face (P3-T06) fused into one
 * `UserAffect`. Pure over explicit times, so a recorded session replays exactly
 * (`replayFusion`).
 *
 * **Each source keeps only its latest reading**, weighted by three things:
 *
 * - **how much the channel is trusted** (`weights`): the model's read most — it reads
 *   situations — then the surface of the text, the face, and the voice least, because on
 *   Rick's voice the default model mostly heard "neutral, a bit happy" (D-34);
 * - **its own confidence**, as the reader gave it;
 * - **how old it is**: each source fades with its own half-life — a message's feeling
 *   lingers into the next turn, a face reading is about now.
 *
 * Two rules on top, both measured: the face counts half while the user is speaking (a
 * talking mouth is not an expression, P3-T06), and a voice reading of `neutral` below
 * `voiceNeutralFloor` is no evidence at all rather than evidence of calm (D-34).
 *
 * Valence and arousal are the weighted mean; the label is the weighted vote; confidence is
 * the winner's share of the vote times how much evidence there is in all (independent
 * witnesses: 1 − Π(1 − wᵢ)). Nothing to go on is `null`, never a guessed neutral.
 */

export type AffectSource = 'text' | 'tag' | 'voice' | 'face';
export const AFFECT_SOURCES: readonly AffectSource[] = ['text', 'tag', 'voice', 'face'];

export interface FusionParams {
  readonly weights: Readonly<Record<AffectSource, number>>;
  readonly halfLifeMs: Readonly<Record<AffectSource, number>>;
  /** The face's weight is multiplied by this while the user is speaking. */
  readonly speakingFace: number;
  /** A voice `neutral` below this confidence says the model could not tell (D-34). */
  readonly voiceNeutralFloor: number;
  /** Less total weight than this and there is nothing to report. */
  readonly minEvidence: number;
  /** The model's read of the *previous* message, once a new one arrives, counts this much. */
  readonly previousTag: number;
}

export const DEFAULT_FUSION_PARAMS: FusionParams = {
  weights: { tag: 1, text: 0.8, face: 0.6, voice: 0.35 },
  halfLifeMs: { tag: 90_000, text: 90_000, voice: 45_000, face: 4000 },
  speakingFace: 0.5,
  voiceNeutralFloor: 0.5,
  minEvidence: 0.1,
  previousTag: 0.25,
};

export interface TimedReading {
  readonly source: AffectSource;
  readonly reading: AffectReading;
  readonly at: number;
  /** A `tag` reading about an earlier turn than the latest. */
  readonly previous?: boolean;
}

const LABELS: readonly UserEmotion[] = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];

/** The weight a reading carries at `at`, before any other reading is considered. */
export function readingWeight(entry: TimedReading, at: number, speaking: boolean, params: FusionParams = DEFAULT_FUSION_PARAMS): number {
  const { source, reading } = entry;
  if (source === 'voice' && reading.label === 'neutral' && reading.confidence < params.voiceNeutralFloor) return 0;
  if (reading.label === 'other' || reading.label === 'unknown') return 0;
  const age = Math.max(0, at - entry.at);
  const decay = 0.5 ** (age / params.halfLifeMs[source]);
  const talking = source === 'face' && speaking ? params.speakingFace : 1;
  const earlier = entry.previous === true ? params.previousTag : 1;
  return Math.min(1, params.weights[source] * reading.confidence * decay * talking * earlier);
}

/** Six places: enough for any reader, and it keeps a recording's replay free of float noise in snapshots. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The fused estimate from these readings at `at`, or null when they say nothing. */
export function fuseReadings(
  entries: readonly TimedReading[],
  at: number,
  speaking = false,
  params: FusionParams = DEFAULT_FUSION_PARAMS,
): UserAffect | null {
  const weighed = entries.map((entry) => ({ entry, weight: readingWeight(entry, at, speaking, params) })).filter(({ weight }) => weight > 0);
  const total = weighed.reduce((sum, { weight }) => sum + weight, 0);
  if (total < params.minEvidence) return null;
  let valence = 0;
  let arousal = 0;
  const votes = new Map<UserEmotion, number>();
  let unheard = 1;
  for (const { entry, weight } of weighed) {
    valence += weight * entry.reading.valence;
    arousal += weight * entry.reading.arousal;
    votes.set(entry.reading.label, (votes.get(entry.reading.label) ?? 0) + weight);
    unheard *= 1 - weight;
  }
  let label: UserEmotion = 'neutral';
  let best = -1;
  // `LABELS` order breaks ties, so a tie resolves the same way every time.
  for (const candidate of LABELS) {
    const vote = votes.get(candidate) ?? 0;
    if (vote > best) {
      label = candidate;
      best = vote;
    }
  }
  return {
    label,
    valence: round(valence / total),
    arousal: round(arousal / total),
    confidence: round((best / total) * (1 - unheard)),
    readings: weighed.map(({ entry }) => entry.reading),
    at: new Date(at).toISOString(),
  };
}

/** One input to the fusion, as a recording holds it. */
export type FusionInput =
  | { readonly kind: 'reading'; readonly at: number; readonly source: 'voice' | 'face'; readonly reading: AffectReading }
  | { readonly kind: 'tag'; readonly at: number; readonly reading: AffectReading }
  | { readonly kind: 'turn'; readonly at: number; readonly text: string }
  | { readonly kind: 'speaking'; readonly at: number; readonly speaking: boolean };

/**
 * The fusion's state, its inputs, and **when it speaks up**. `turn` is a user's message or
 * spoken turn: its words are read, everything is fused, and the result is what the character
 * takes in. `tag` is the model's `[user:x]` for that turn, first in its reply: it speaks up
 * again only if it changes the label, and only once a turn. Readings and speaking only move
 * the state. So the engine takes in how the user seems once per thing they say (twice at
 * most), not on every camera frame — and because the rule lives here, a replay publishes
 * exactly what the live session did.
 */
export class UserAffectFusion {
  private readonly params: FusionParams;
  private readonly latest = new Map<AffectSource, TimedReading>();
  private readonly pace = new MessagePace();
  private speaking = false;
  private tagged = false;
  private published: UserAffect | null = null;
  private readonly listeners = new Set<(input: FusionInput) => void>();

  constructor(params: FusionParams = DEFAULT_FUSION_PARAMS) {
    this.params = params;
  }

  /** Every input, as it arrives — for a recorder. */
  onInput(listener: (input: FusionInput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(source: 'voice' | 'face', reading: AffectReading, at: number): void {
    const plain = stripCues(reading);
    this.emit({ kind: 'reading', at, source, reading: plain });
    this.latest.set(source, { source, reading: plain, at });
  }

  setSpeaking(speaking: boolean, at: number): void {
    this.emit({ kind: 'speaking', at, speaking });
    this.speaking = speaking;
  }

  /** A user turn: read its words; returns what to publish (null: nothing to go on). */
  turn(text: string, at: number): UserAffect | null {
    this.emit({ kind: 'turn', at, text });
    this.tagged = false;
    const tag = this.latest.get('tag');
    if (tag !== undefined) this.latest.set('tag', { ...tag, previous: true });
    const reading = readUserText(text, this.pace.observe(at));
    this.latest.set('text', { source: 'text', reading: stripCues(reading), at });
    return this.publish(this.current(at));
  }

  /** The model's read of this turn; returns what to publish if it changed the label. */
  tag(reading: AffectReading, at: number): UserAffect | null {
    if (this.tagged) return null;
    this.emit({ kind: 'tag', at, reading });
    this.tagged = true;
    this.latest.set('tag', { source: 'tag', reading, at });
    const updated = this.current(at);
    return updated !== null && updated.label !== this.published?.label ? this.publish(updated) : null;
  }

  current(at: number): UserAffect | null {
    return fuseReadings([...this.latest.values()], at, this.speaking, this.params);
  }

  /** The last estimate published — what the prompt says. */
  last(): UserAffect | null {
    return this.published;
  }

  /** The latest reading per source, for a debug overlay. */
  sources(): readonly TimedReading[] {
    return AFFECT_SOURCES.flatMap((source) => {
      const entry = this.latest.get(source);
      return entry === undefined ? [] : [entry];
    });
  }

  private publish(affect: UserAffect | null): UserAffect | null {
    if (affect !== null) this.published = affect;
    return affect;
  }

  private emit(input: FusionInput): void {
    for (const listener of this.listeners) listener(input);
  }
}

/** The protocol's reading only: each reader adds its own extras (cues, scores, probabilities), which the bus and a recording would otherwise carry along. */
function stripCues(reading: AffectReading): AffectReading {
  return { channel: reading.channel, label: reading.label, valence: reading.valence, arousal: reading.arousal, confidence: reading.confidence };
}

/** What `attachUserAffect` needs from the conversation machine. */
export interface FusionMachine {
  subscribe(listener: (event: ConversationEvent) => void): () => void;
  dispatch(event: ConversationEvent): void;
}

export interface AttachedUserAffect {
  readonly fusion: UserAffectFusion;
  /**
   * A spoken turn, from the call, **before** its transcript is published: `VoiceSession`
   * builds the model's request first (P1-T12b), so this is how the prompt sees the turn.
   */
  spokenTurn(text: string, voice: AffectReading | null, at: number): void;
  /** A face reading, from the camera (P3-T06). */
  face(reading: AffectReading, at: number): void;
  readonly detach: () => void;
}

/**
 * The fusion on a conversation's bus (P3-T07). Typed messages arrive as `user.message`; a
 * spoken turn is handed over by the call (`spokenTurn`); speech start and end mark when the
 * face is a talking face; the model's `[user:x]` arrives with the first sentence of its
 * reply. What the fusion publishes goes on the bus as `affect.user.updated`, where the
 * affect engine takes it in by empathy.
 */
export function attachUserAffect(machine: FusionMachine, options: { readonly sessionId: string; readonly params?: FusionParams }): AttachedUserAffect {
  const fusion = new UserAffectFusion(options.params);
  const publish = (affect: UserAffect | null, at: number): void => {
    if (affect !== null) machine.dispatch({ sessionId: options.sessionId, at: new Date(at).toISOString(), type: 'affect.user.updated', affect });
  };
  const detach = machine.subscribe((event) => {
    const at = Date.parse(event.at);
    switch (event.type) {
      case 'user.message':
        publish(fusion.turn(event.text, at), at);
        return;
      case 'user.speech.started':
        fusion.setSpeaking(true, at);
        return;
      case 'user.speech.ended':
        fusion.setSpeaking(false, at);
        return;
      case 'assistant.sentence': {
        const tag = event.tags.find((candidate) => candidate.kind === 'user');
        const reading = tag === undefined ? null : readingFromTag(tag);
        if (reading !== null) publish(fusion.tag(reading, at), at);
        return;
      }
      default:
    }
  });
  return {
    fusion,
    spokenTurn: (text, voice, at) => {
      if (voice !== null) fusion.observe('voice', voice, at);
      publish(fusion.turn(text, at), at);
    },
    face: (reading, at) => fusion.observe('face', reading, at),
    detach,
  };
}

/** A recorded session: every fusion input, in order. */
export interface FusionRecording {
  readonly version: 1;
  readonly inputs: readonly FusionInput[];
}

export function recordFusion(fusion: UserAffectFusion): { recording(): FusionRecording; stop(): void } {
  const inputs: FusionInput[] = [];
  const stop = fusion.onInput((input) => inputs.push(input));
  return { recording: () => ({ version: 1, inputs: [...inputs] }), stop };
}

/**
 * Replays a recording through a fresh fusion: everything it published, in order. The same
 * recording gives the same answers every time — no clock, no randomness, no I/O.
 */
export function replayFusion(recording: FusionRecording, params: FusionParams = DEFAULT_FUSION_PARAMS): UserAffect[] {
  const fusion = new UserAffectFusion(params);
  const published: UserAffect[] = [];
  const keep = (affect: UserAffect | null): void => {
    if (affect !== null) published.push(affect);
  };
  for (const input of recording.inputs) {
    if (input.kind === 'reading') fusion.observe(input.source, input.reading, input.at);
    else if (input.kind === 'speaking') fusion.setSpeaking(input.speaking, input.at);
    else if (input.kind === 'tag') keep(fusion.tag(input.reading, input.at));
    else keep(fusion.turn(input.text, input.at));
  }
  return published;
}
