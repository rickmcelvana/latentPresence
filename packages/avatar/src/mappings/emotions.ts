import type { CharacterEmotion, ExpressionWeights } from '@latentpresence/protocol';

/**
 * `[emote:x]` → the face (P2-T07). VRM presets first, because every VRM has them and
 * P2-T01's table resolves the rest per model (a preset-only model shows nothing for a brow,
 * rather than the wrong thing). Weights stay under ~0.7: a full preset at rest reads as a
 * caricature, and a strong `happy` also fights the mouth shapes while she talks.
 */
export const EMOTION_EXPRESSIONS: Readonly<Record<CharacterEmotion, ExpressionWeights>> = {
  neutral: {},
  joy: { happy: 0.7 },
  affection: { happy: 0.4, relaxed: 0.4 },
  amusement: { happy: 0.55, relaxed: 0.15 },
  curiosity: { surprised: 0.2, browInnerUp: 0.4 },
  surprise: { surprised: 0.7 },
  concern: { sad: 0.35, browInnerUp: 0.5 },
  sadness: { sad: 0.7 },
  frustration: { angry: 0.45 },
  embarrassment: { happy: 0.25, sad: 0.2 },
  pride: { happy: 0.45, relaxed: 0.25 },
  relief: { relaxed: 0.6 },
};
