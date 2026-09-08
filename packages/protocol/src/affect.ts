import { z } from 'zod';
import { IdSchema, SignedUnitSchema, TimestampSchema, UnitIntervalSchema } from './common';

/**
 * The mood of the character as a PAD vector: slow-moving, persisted between sessions,
 * and the thing that makes face, voice and wording agree (ADR-12).
 */
export const MoodSchema = z.object({
  pleasure: SignedUnitSchema,
  arousal: SignedUnitSchema,
  dominance: SignedUnitSchema,
});
export type Mood = z.infer<typeof MoodSchema>;

/**
 * What the character can feel and show. Deliberately small: the LLM emits these in
 * `[emote:x]` tags, and P2-T01 maps each one onto VRM expression presets, so a label
 * nothing can express is worse than a coarse label.
 */
export const CharacterEmotionSchema = z.enum([
  'neutral',
  'joy',
  'affection',
  'amusement',
  'curiosity',
  'surprise',
  'concern',
  'sadness',
  'frustration',
  'embarrassment',
  'pride',
  'relief',
]);
export type CharacterEmotion = z.infer<typeof CharacterEmotionSchema>;

/**
 * What the sensing side can report about the user. These are the nine classes the
 * prosody models emit (RESEARCH section 5); the text and face channels map onto the
 * same set so the fused estimate has one vocabulary.
 */
export const UserEmotionSchema = z.enum([
  'neutral',
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'other',
  'unknown',
]);
export type UserEmotion = z.infer<typeof UserEmotionSchema>;

/** Where an emotion event came from. `llm-tag` is the `[emote:x]` protocol (P1-T12). */
export const EmotionSourceSchema = z.enum([
  'llm-tag',
  'user-affect',
  'conversation',
  'memory',
  'schedule',
  'internal',
]);
export type EmotionSource = z.infer<typeof EmotionSourceSchema>;

/**
 * A fast, decaying feeling laid over the slow mood. Intensity halves every
 * `halfLifeMs`; the affect engine drops an event once it is negligible.
 */
export const EmotionEventSchema = z.object({
  label: CharacterEmotionSchema,
  intensity: UnitIntervalSchema,
  source: EmotionSourceSchema,
  at: TimestampSchema,
  halfLifeMs: z.number().int().positive(),
});
export type EmotionEvent = z.infer<typeof EmotionEventSchema>;

/** How the character is holding itself towards the user right now. */
export const SocialStanceSchema = z.object({
  /** Cold to affectionate. */
  warmth: SignedUnitSchema,
  /** Casual to formal. */
  formality: SignedUnitSchema,
  /** Withdrawn to leaning in. */
  engagement: SignedUnitSchema,
});
export type SocialStance = z.infer<typeof SocialStanceSchema>;

/** The whole affect state, persisted per character (ADR-12). */
export const AffectStateSchema = z.object({
  characterId: IdSchema,
  mood: MoodSchema,
  events: z.array(EmotionEventSchema),
  /** Flat out to lively. Drives pace, gesture size, and how much the character offers. */
  energy: UnitIntervalSchema,
  stance: SocialStanceSchema,
  updatedAt: TimestampSchema,
});
export type AffectState = z.infer<typeof AffectStateSchema>;

/** The channels emotion can be read from. Face is opt-in and never leaves the machine. */
export const AffectChannelSchema = z.enum(['text', 'voice', 'face', 'omni']);
export type AffectChannel = z.infer<typeof AffectChannelSchema>;

/** One channel's opinion, before fusion. */
export const AffectReadingSchema = z.object({
  channel: AffectChannelSchema,
  valence: SignedUnitSchema,
  arousal: SignedUnitSchema,
  confidence: UnitIntervalSchema,
  label: UserEmotionSchema,
});
export type AffectReading = z.infer<typeof AffectReadingSchema>;

/**
 * The fused estimate of how the user seems. One short line of this reaches the LLM
 * context; raw audio and video never do.
 */
export const UserAffectSchema = z.object({
  valence: SignedUnitSchema,
  arousal: SignedUnitSchema,
  confidence: UnitIntervalSchema,
  label: UserEmotionSchema,
  /** The per-channel readings this estimate was fused from, for debugging and display. */
  readings: z.array(AffectReadingSchema),
  at: TimestampSchema,
});
export type UserAffect = z.infer<typeof UserAffectSchema>;

/**
 * Expression names the renderer understands: the VRM 1.0 emotion presets plus the
 * ARKit-style extras the character pipeline produces. P2-T01 owns the mapping table
 * from these names to whatever a loaded model actually has.
 */
export const ExpressionNameSchema = z.enum([
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'browInnerUp',
  'browDownLeft',
  'browDownRight',
  'cheekSquint',
  'mouthSmile',
  'mouthFrown',
  'eyeSquint',
  'eyeWide',
]);
export type ExpressionName = z.infer<typeof ExpressionNameSchema>;

/**
 * Blend weights for the expressions being driven right now. `partialRecord`, because a
 * full record would demand every name on every frame (SURFACE 2026-09-08).
 */
export const ExpressionWeightsSchema = z.partialRecord(ExpressionNameSchema, UnitIntervalSchema);
export type ExpressionWeights = z.infer<typeof ExpressionWeightsSchema>;

/** Where the character is looking: the set the gaze policy chooses between (P2-T02). */
export const GazeTargetSchema = z.enum(['user', 'away', 'wander', 'screen', 'down']);
export type GazeTarget = z.infer<typeof GazeTargetSchema>;

/**
 * What the affect engine tells a TTS provider. Each adapter maps it to whatever its
 * backend supports: a style tag, instruct text, a speed change, or nothing at all.
 */
export const EmotionHintSchema = z.object({
  label: CharacterEmotionSchema,
  intensity: UnitIntervalSchema,
  energy: UnitIntervalSchema,
});
export type EmotionHint = z.infer<typeof EmotionHintSchema>;

/**
 * Everything the affect engine emits for one moment: what the face does, where the eyes
 * go, how the voice is hinted, and the short note the LLM is given about how it feels.
 */
export const AffectDirectiveSchema = z.object({
  expression: ExpressionWeightsSchema,
  gaze: GazeTargetSchema,
  /** Bias for clip selection: which gesture families fit the current state. */
  gestureBias: z.array(z.string()),
  voice: EmotionHintSchema,
  /** The "how you feel" injection, kept short on purpose (ADR-12). */
  systemNote: z.string().max(400),
});
export type AffectDirective = z.infer<typeof AffectDirectiveSchema>;
