import type { WordTiming } from '@latentpresence/protocol';
import { MOUTH_SHAPES, type MouthShape } from '../fake';
import { type OculusViseme, toVrmViseme } from '../visemes';

/**
 * From "which sound, how loud" to five mouth weights, smoothed.
 *
 * **Opens fast and closes a little slower.** P2-T04 measured the analyser's own lag
 * (`docs/SURFACE.md`): onsets arrive within a render quantum or two, and the time to close
 * after a sound stops is what blows a sync budget — wawa's defaults held the mouth open
 * 153 ms past the end of a word. So the smoothing here is asymmetric and short: a snap
 * open would read as a twitch, a slow close as mumbling.
 *
 * **One shape leads, the rest fade.** Only the current viseme is driven towards the
 * volume; the others ease to zero, so a vowel change is a blend and not a cut. The total
 * is capped, because two shapes each at 0.8 on a VRM model is a mouth wider than any
 * the author sculpted — which is also all the "jaw" there is: VRM 1.0 moves the jaw through
 * `aa`, not a bone.
 */
export interface MouthParams {
  /** Half-life of an opening shape, ms. */
  readonly attackMs: number;
  /** Half-life of a closing one, ms. */
  readonly releaseMs: number;
  /** Volume on the analyser's 0..1 dB scale times this is the weight. */
  readonly gain: number;
  /** Below this volume the frame counts as silence. */
  readonly floor: number;
  /** The most all five shapes may add up to. */
  readonly maxTotal: number;
}

/**
 * Measured on Kokoro speech (`e2e/fixtures/speech.wav`) through the real analyser, offline
 * (P2-T04, `docs/SURFACE.md`). **The floor is the dial that matters**: the analyser's
 * volume is on a −100…−30 dB scale, so the quiet tail after a word still reads 0.18 at the
 * 90th percentile while the quietest tenth of speech reads 0.33. At 0.08 the mouth closed a
 * median 170 ms after speech stopped; at 0.25 it closes in 55 and opens in 15, and the
 * gain maps the rest of the range (to ~0.55, loud speech) onto an open mouth.
 */
export const DEFAULT_MOUTH_PARAMS: MouthParams = {
  attackMs: 12,
  releaseMs: 28,
  gain: 3.3,
  floor: 0.25,
  maxTotal: 1,
};

export type MouthWeights = ReadonlyMap<MouthShape, number>;

export const CLOSED_MOUTH: MouthWeights = new Map(MOUTH_SHAPES.map((shape) => [shape, 0]));

function approach(current: number, target: number, deltaMs: number, halfLifeMs: number): number {
  if (deltaMs <= 0) return current;
  if (halfLifeMs <= 0) return target;
  return current + (target - current) * (1 - 2 ** (-deltaMs / halfLifeMs));
}

export class MouthDriver {
  private readonly params: MouthParams;
  private weights = new Map(CLOSED_MOUTH);

  constructor(params: MouthParams = DEFAULT_MOUTH_PARAMS) {
    this.params = params;
  }

  /** One frame: the heard viseme, its loudness, and the time since the last frame. */
  update(viseme: OculusViseme, volume: number, deltaMs: number): MouthWeights {
    const { attackMs, releaseMs, gain, floor, maxTotal } = this.params;
    const shape = toVrmViseme(viseme);
    const open = volume > floor && shape !== 'sil' ? Math.min(1, (volume - floor) * gain) : 0;

    for (const candidate of MOUTH_SHAPES) {
      const target = candidate === shape ? open : 0;
      const current = this.weights.get(candidate) ?? 0;
      this.weights.set(candidate, approach(current, target, deltaMs, target > current ? attackMs : releaseMs));
    }

    const total = [...this.weights.values()].reduce((sum, w) => sum + w, 0);
    if (total > maxTotal) {
      for (const [candidate, weight] of this.weights) this.weights.set(candidate, (weight * maxTotal) / total);
    }
    return this.weights;
  }

  reset(): void {
    this.weights = new Map(CLOSED_MOUTH);
  }
}

/**
 * The other source: visemes from word timings, for a TTS that reports them.
 *
 * Plan text: "if the TTS provides word or phoneme timing, drive from timing instead". No
 * provider does today — neither Kokoro nor the OpenAI-compatible surface returns timings
 * (P1-T05), and `PlaybackSegment` carries none — so this is the path that runs when one
 * does. Words, not phonemes, so the shape is read from the spelling: each vowel group
 * gets an even share of the word's time and its nearest mouth shape, which is coarse but
 * never open between words, and between words is where a timing source beats analysis.
 */
export function visemeAt(words: readonly WordTiming[], atMs: number): { viseme: OculusViseme; volume: number } {
  const word = words.find((w) => atMs >= w.startMs && atMs < w.endMs);
  if (word === undefined) return { viseme: 'viseme_sil', volume: 0 };
  const groups = word.text.toLowerCase().match(/[aeiouy]+/g) ?? [];
  if (groups.length === 0) return { viseme: 'viseme_PP', volume: 0.3 };
  const share = (word.endMs - word.startMs) / groups.length;
  const index = Math.min(groups.length - 1, Math.floor((atMs - word.startMs) / share));
  return { viseme: vowelViseme(groups[index] ?? 'a'), volume: 0.5 };
}

function vowelViseme(group: string): OculusViseme {
  const first = group[0];
  if (first === 'a') return 'viseme_aa';
  if (first === 'e') return 'viseme_E';
  if (first === 'i' || first === 'y') return 'viseme_I';
  if (first === 'o') return 'viseme_O';
  return 'viseme_U';
}
