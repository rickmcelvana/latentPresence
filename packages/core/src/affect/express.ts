import type { AffectState, CharacterEmotion, EmotionHint, InlineTag } from '@latentpresence/protocol';
import { eventIntensity } from './engine';
import { DEFAULT_AFFECT_PARAMS, EMOTION_PAD, type AffectParams } from './params';

/**
 * Affect to voice and wording (P3-T03, ADR-12): the two outputs of the engine that are not
 * the body. Pure, like P3-T02's `affectToBody` — the caller holds the engine and asks.
 *
 * - **Voice.** A TTS backend with emotion control (the server adapter's `instructions`) is
 *   given an `EmotionHint`. Kokoro, the default voice, has no such control at all, so every
 *   voice also gets **prosody we own**: a pace multiplier and the silence after each
 *   sentence (ADR-27's tail). Those are applied to whatever the backend returns, so they
 *   work on every voice, and they are small — Kokoro degrades past 1.25× (D-13).
 * - **Wording.** A two-line note for the system prompt: how she feels, in words a model
 *   can use and told not to announce, and how much to say. Numbers never reach the model.
 *
 * Every number here is hand-set, as the engine's are, and meets a person in R-19.
 */

export interface ExpressParams {
  /** The furthest the pace moves either way from the voice's own speed, as a fraction. */
  readonly maxRateShift: number;
  /** The silence after a sentence at rest, ms: ADR-27's measured tail. */
  readonly restPauseMs: number;
  readonly minPauseMs: number;
  readonly maxPauseMs: number;
  /** How far the pause moves, as a fraction of the rest pause, at full drive. */
  readonly pauseShift: number;
  /** Below this a mood is not a feeling worth naming: the baseline sits at ~0.21. */
  readonly moodFelt: number;
  /** Below this a passing feeling is not worth naming in the prompt. */
  readonly eventFelt: number;
  /** Where talkativeness tips into "keep it short" or "say more". */
  readonly lengthThreshold: number;
}

export const DEFAULT_EXPRESS_PARAMS: ExpressParams = {
  maxRateShift: 0.15,
  restPauseMs: 250,
  minPauseMs: 150,
  maxPauseMs: 450,
  pauseShift: 0.6,
  moodFelt: 0.3,
  eventFelt: 0.25,
  lengthThreshold: 0.2,
};

/** How a sentence should sound, for `Reply` (P3-T03). */
export interface VoiceStyle {
  /** For a backend with emotion control (`TtsRequest.hint`); others drop it. */
  readonly hint: EmotionHint;
  /** Multiplies the voice's own speed. Every backend honours it. */
  readonly rate: number;
  /** Silence kept after the sentence's voice, ms. Every backend gets it: we trim. */
  readonly pauseMs: number;
}

/** Kokoro's usable range (D-13), which `PersonaVoiceSchema` also holds a persona to. */
export const MIN_SPEED = 0.75;
export const MAX_SPEED = 1.25;

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** A voice's speed with a style's pace applied, inside the range the voice can hold. */
export function styledSpeed(base: number, style: VoiceStyle | null): number {
  return clamp(base * (style?.rate ?? 1), MIN_SPEED, MAX_SPEED);
}

/**
 * What she feels at `at`, as one label: the strongest live feeling if it is worth naming,
 * otherwise the feeling nearest her mood if the mood is far enough from neutral to be one.
 */
export function feltEmotion(
  state: AffectState,
  at: number,
  express: ExpressParams = DEFAULT_EXPRESS_PARAMS,
  params: AffectParams = DEFAULT_AFFECT_PARAMS,
): { readonly label: CharacterEmotion; readonly intensity: number; readonly from: 'event' | 'mood' | 'none' } {
  let best: { label: CharacterEmotion; intensity: number } | null = null;
  for (const event of state.events) {
    const now = eventIntensity(event, at);
    if (now >= params.negligible && (best === null || now > best.intensity)) best = { label: event.label, intensity: now };
  }
  if (best !== null && best.intensity >= express.eventFelt) return { ...best, from: 'event' };

  const { pleasure, arousal, dominance } = state.mood;
  const size = Math.hypot(pleasure, arousal, dominance);
  if (size < express.moodFelt) return { label: 'neutral', intensity: 0, from: 'none' };
  let nearest: CharacterEmotion = 'neutral';
  let distance = Infinity;
  for (const [label, point] of Object.entries(EMOTION_PAD) as [CharacterEmotion, AffectState['mood']][]) {
    if (label === 'neutral') continue;
    const d = Math.hypot(point.pleasure - pleasure, point.arousal - arousal, point.dominance - dominance);
    if (d < distance) {
      distance = d;
      nearest = label;
    }
  }
  return { label: nearest, intensity: clamp(size, 0, 1), from: 'mood' };
}

/**
 * How lively she is against her own baseline, −1 (flat, slow) to 1 (keyed up). Arousal and
 * energy both count; it is what pace and pauses follow.
 */
function drive(state: AffectState, params: AffectParams): number {
  const base = params.baseline;
  return clamp(0.6 * (state.mood.arousal - base.mood.arousal) + (state.energy - base.energy), -1, 1);
}

/**
 * How a sentence should sound. `tags` are the sentence's own: an `[emote:x]` the model wrote
 * on it names the feeling for that line, as the face already does (P2-T07), so the voice
 * never contradicts the face even before the engine has absorbed the tag.
 */
export function affectToVoice(
  state: AffectState,
  at: number,
  tags: readonly InlineTag[] = [],
  express: ExpressParams = DEFAULT_EXPRESS_PARAMS,
  params: AffectParams = DEFAULT_AFFECT_PARAMS,
): VoiceStyle {
  const tagged = tags.find((tag) => tag.kind === 'emote' && tag.known !== null && tag.known in EMOTION_PAD);
  const felt =
    tagged === undefined
      ? feltEmotion(state, at, express, params)
      : { label: tagged.known as CharacterEmotion, intensity: params.tagIntensity };
  const lively = drive(state, params);
  return {
    hint: { label: felt.label, intensity: clamp(felt.intensity, 0, 1), energy: clamp(state.energy, 0, 1) },
    rate: 1 + express.maxRateShift * lively,
    pauseMs: Math.round(
      clamp(express.restPauseMs * (1 - express.pauseShift * lively), express.minPauseMs, express.maxPauseMs),
    ),
  };
}

/** A feeling as the model is told it: an adjective, so it reads as a state, not an order. */
const FELT: Readonly<Record<CharacterEmotion, string>> = {
  neutral: 'settled',
  joy: 'delighted',
  affection: 'fond of them',
  amusement: 'amused',
  curiosity: 'curious',
  surprise: 'surprised',
  concern: 'concerned',
  sadness: 'sad',
  frustration: 'frustrated',
  embarrassment: 'embarrassed',
  pride: 'proud',
  relief: 'relieved',
};

function moodWords(state: AffectState): string[] {
  const { pleasure, arousal, dominance } = state.mood;
  const { warmth, engagement } = state.stance;
  const words: string[] = [];
  if (pleasure >= 0.5) words.push('happy');
  else if (pleasure >= 0.3) words.push('content');
  else if (pleasure <= -0.5) words.push('unhappy');
  else if (pleasure <= -0.2) words.push('a little low');
  if (arousal >= 0.4) words.push('lively');
  else if (arousal <= -0.3) words.push('tired and slow');
  else if (arousal <= -0.15) words.push('quiet');
  if (dominance >= 0.35) words.push('sure of yourself');
  else if (dominance <= -0.3) words.push('unsure of yourself');
  if (warmth <= -0.1) words.push('cool towards them');
  else if (warmth >= 0.75) words.push('very warm towards them');
  if (engagement <= -0.1) words.push('not very engaged');
  else if (engagement >= 0.65) words.push('keen to hear more');
  return words;
}

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * How much she feels like saying, −1 to 1 against her baseline: energy, engagement and
 * arousal. It becomes one of three sentences, never a word count.
 */
export function talkativeness(state: AffectState, params: AffectParams = DEFAULT_AFFECT_PARAMS): number {
  const base = params.baseline;
  return clamp(
    (state.energy - base.energy) + 0.5 * (state.stance.engagement - base.stance.engagement) + 0.3 * (state.mood.arousal - base.mood.arousal),
    -1,
    1,
  );
}

/**
 * The two lines for the system prompt (ADR-12's "how you feel"): the feeling, and the
 * reply-length bias. Short on purpose — `AffectDirective.systemNote` allows 400 characters.
 */
export function describeFeeling(
  state: AffectState,
  at: number,
  express: ExpressParams = DEFAULT_EXPRESS_PARAMS,
  params: AffectParams = DEFAULT_AFFECT_PARAMS,
): { readonly feeling: string; readonly length: string } {
  const words = moodWords(state);
  const felt = feltEmotion(state, at, express, params);
  const now = felt.from === 'event' ? FELT[felt.label] : null;
  const mood = words.length === 0 ? 'settled, your usual self' : list(words);
  const feeling =
    `You are feeling ${mood}${now === null || words.includes(now) ? '' : `, and right now ${now}`}. ` +
    'Let it colour your tone and your choice of words; do not say it out loud.';

  const talk = talkativeness(state, params);
  const length =
    talk <= -express.lengthThreshold
      ? 'You do not feel like talking much: keep replies to a sentence or two unless they ask for more.'
      : talk >= express.lengthThreshold
        ? 'You feel talkative: take the room to say a bit more, and ask them something back.'
        : 'Say as much as the moment needs and no more.';
  return { feeling, length };
}
