import type { CharacterEmotion, Mood, SocialStance } from '@latentpresence/protocol';

/**
 * The ten states Rick's sign-off runs through (P3-T02's done-when), in one place so the
 * review is reproducible: `/dev/avatar`'s Affect panel sets its sliders from one of these
 * and switches its source to `sliders`.
 *
 * PAD values sit clearly inside each octant (|component| ≈ 0.6, see `affectRegion`);
 * `neutral` and `joy flash` use the core baseline instead (`docs/affect.md`: pleasure 0.2,
 * arousal 0.05, dominance 0), since reading as neutral is the point of both — `joy flash`
 * shows a strong feeling riding on an otherwise neutral resting face. Each state carries a
 * feeling that fits its region (`anxious` → `concern`, and so on).
 */
export interface AffectReviewState {
  readonly name: string;
  readonly mood: Mood;
  readonly energy: number;
  /** Formality is not one of the panel's sliders — `affectToBody` never reads it — and
   * stays 0 for every state. */
  readonly stance: SocialStance;
  readonly feeling: { readonly label: CharacterEmotion; readonly intensity: number };
}

function stance(warmth: number, engagement: number): SocialStance {
  return { warmth, formality: 0, engagement };
}

export const AFFECT_REVIEW_STATES: readonly AffectReviewState[] = [
  {
    name: 'neutral',
    mood: { pleasure: 0.2, arousal: 0.05, dominance: 0 },
    energy: 0.6,
    stance: stance(0.4, 0.3),
    feeling: { label: 'neutral', intensity: 0 },
  },
  {
    name: 'exuberant',
    mood: { pleasure: 0.6, arousal: 0.6, dominance: 0.6 },
    energy: 0.8,
    stance: stance(0.6, 0.6),
    feeling: { label: 'joy', intensity: 0.6 },
  },
  {
    name: 'relaxed',
    mood: { pleasure: 0.6, arousal: -0.6, dominance: 0.6 },
    energy: 0.35,
    stance: stance(0.5, 0.2),
    feeling: { label: 'relief', intensity: 0.4 },
  },
  {
    name: 'dependent',
    mood: { pleasure: 0.6, arousal: 0.6, dominance: -0.6 },
    energy: 0.7,
    stance: stance(0.6, 0.7),
    feeling: { label: 'affection', intensity: 0.5 },
  },
  {
    name: 'docile',
    mood: { pleasure: 0.6, arousal: -0.6, dominance: -0.6 },
    energy: 0.3,
    stance: stance(0.4, 0.1),
    feeling: { label: 'relief', intensity: 0.3 },
  },
  {
    name: 'hostile',
    mood: { pleasure: -0.6, arousal: 0.6, dominance: 0.6 },
    energy: 0.75,
    stance: stance(-0.5, 0.4),
    feeling: { label: 'frustration', intensity: 0.6 },
  },
  {
    name: 'anxious',
    mood: { pleasure: -0.6, arousal: 0.6, dominance: -0.6 },
    energy: 0.65,
    stance: stance(0.1, 0.3),
    feeling: { label: 'concern', intensity: 0.5 },
  },
  {
    name: 'disdainful',
    mood: { pleasure: -0.6, arousal: -0.6, dominance: 0.6 },
    energy: 0.3,
    stance: stance(-0.4, -0.3),
    feeling: { label: 'frustration', intensity: 0.2 },
  },
  {
    name: 'bored',
    mood: { pleasure: -0.6, arousal: -0.6, dominance: -0.6 },
    energy: 0.15,
    stance: stance(0, -0.4),
    feeling: { label: 'sadness', intensity: 0.2 },
  },
  {
    name: 'joy flash',
    mood: { pleasure: 0.2, arousal: 0.05, dominance: 0 },
    energy: 0.6,
    stance: stance(0.4, 0.3),
    feeling: { label: 'joy', intensity: 0.9 },
  },
];
