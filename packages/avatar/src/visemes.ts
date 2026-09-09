import { type Viseme, VisemeSchema } from '@latentpresence/protocol';

/**
 * Turning what a lip-sync analyser hears into a mouth a VRM can make.
 *
 * `wawa-lipsync` reports the Oculus/ARKit viseme set — fifteen shapes, most of them
 * consonants. VRM 1.0 has five mouth expressions and silence, which is also what
 * `VisemeSchema` says. **Nine of the fifteen have no VRM equivalent**, so this mapping is
 * a set of deliberate approximations rather than a lookup, and it is the difference
 * between an avatar that speaks and one that appears to be chewing.
 *
 * The rule used throughout: approximate the nearest **mouth shape**, not the nearest
 * sound. A viewer is watching lips, not listening to phonemes — they cannot hear the
 * difference between /p/ and /b/ from a picture, but they can see a mouth that stays open
 * through a word that closes.
 *
 * Verified against the library's published `dist/index.d.ts` on 2026-09-09, not from
 * memory — `docs/SURFACE.md`, "Avatar stack for P0-T05".
 */

/**
 * The Oculus viseme set as `wawa-lipsync` spells it.
 *
 * Written out here rather than imported from the library so `packages/avatar` keeps no
 * dependency on it: the mapping is the part P2 keeps, and it should not drag a 0.0.2
 * package with no repository link into the core. The spike passes the string through.
 */
export const OCULUS_VISEMES = [
  'viseme_sil',
  'viseme_PP',
  'viseme_FF',
  'viseme_TH',
  'viseme_DD',
  'viseme_kk',
  'viseme_CH',
  'viseme_SS',
  'viseme_nn',
  'viseme_RR',
  'viseme_aa',
  'viseme_E',
  'viseme_I',
  'viseme_O',
  'viseme_U',
] as const;

export type OculusViseme = (typeof OCULUS_VISEMES)[number];

/**
 * Oculus to VRM, with the reason on every line that is not a straight vowel.
 *
 * `satisfies Record<OculusViseme, Viseme>` is load-bearing: if the library ever adds a
 * sixteenth viseme, adding it to `OCULUS_VISEMES` fails the build here rather than
 * silently falling through a default to `sil`, which would read as a mouth that stops
 * moving on certain sounds.
 */
export const VISEME_MAP = {
  viseme_sil: 'sil',

  // Bilabial stop: the lips are shut. Closer to silence than to any open vowel, and
  // mapping it to a vowel is what makes a "p" look like a shout.
  viseme_PP: 'sil',
  // Labiodental: lower lip to upper teeth. A narrow, mostly-closed mouth; `ih` is the
  // narrowest VRM shape available.
  viseme_FF: 'ih',
  // Dental, tongue between the teeth. Slightly open and wide — `ih` again.
  viseme_TH: 'ih',
  // Alveolar stop. Tongue does the work behind a barely-open mouth.
  viseme_DD: 'ih',
  // Velar stop, made at the back with the jaw a little open. `oh` carries that better
  // than the wide shapes.
  viseme_kk: 'oh',
  // Postalveolar affricate: lips push slightly forward and round.
  viseme_CH: 'ou',
  // Sibilant: teeth close together, lips drawn wide.
  viseme_SS: 'ih',
  // Nasal. The mouth is closed and the sound comes through the nose.
  viseme_nn: 'sil',
  // Approximant, lips rounded.
  viseme_RR: 'ou',

  // The five that map straight through.
  viseme_aa: 'aa',
  viseme_E: 'ee',
  viseme_I: 'ih',
  viseme_O: 'oh',
  viseme_U: 'ou',
} as const satisfies Record<OculusViseme, Viseme>;

/** Map one analyser viseme onto a VRM mouth. Unknown input is silence, not a guess. */
export function toVrmViseme(oculus: string): Viseme {
  return VISEME_MAP[oculus as OculusViseme] ?? 'sil';
}

/**
 * The analyser's `volume` as a mouth-open weight.
 *
 * `features.volume` is not bounded by the library — it is derived from FFT magnitudes —
 * so it is clamped here. `gain` exists because a conversational speaking level does not
 * reach 1.0 on its own and an avatar that never opens its mouth past a third is not
 * lip syncing, it is mumbling.
 */
export function visemeWeight(volume: number, gain = 1): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  return Math.min(1, volume * gain);
}

/**
 * One frame of smoothing toward a target weight.
 *
 * A mouth snapping between shapes at 60 fps reads as a glitch rather than as speech, and
 * an analyser's winning viseme changes far more often than a real mouth does. This is a
 * frame-rate-independent exponential approach: `halfLifeMs` is the time to close half the
 * remaining distance, so the same constant behaves the same at 30 fps and at 144.
 *
 * It approaches and never overshoots, which matters because an overshoot on a mouth
 * expression is a face pulling a shape the character does not have.
 */
export function smoothWeight(
  current: number,
  target: number,
  deltaMs: number,
  halfLifeMs = 40,
): number {
  if (deltaMs <= 0) return current;
  if (halfLifeMs <= 0) return target;
  const factor = 1 - 2 ** (-deltaMs / halfLifeMs);
  return current + (target - current) * factor;
}

/** Every VRM viseme, for a renderer that has to zero the ones it is not driving. */
export const VRM_VISEMES: readonly Viseme[] = VisemeSchema.options;
