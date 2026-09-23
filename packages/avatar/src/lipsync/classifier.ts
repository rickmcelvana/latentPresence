/*
 * Ported from wawa-lipsync 0.0.2 (https://github.com/wass08/wawa-lipsync), MIT License:
 *
 *   Copyright (c) 2025 Wassim SAMAD
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the Software
 *   without restriction, including without limitation the rights to use, copy, modify,
 *   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to the following
 *   conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies
 *   or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 *   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 *   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
 *   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import type { OculusViseme } from '../visemes';

/**
 * wawa-lipsync's viseme classifier, as a pure function of one spectrum frame.
 *
 * **Why a port and not the package** (P2-T04): the library builds its own `AudioContext`
 * and accepts only an `HTMLMediaElement` or the microphone, while the character's voice
 * plays through an AudioWorklet in *our* context — and a node cannot connect across
 * contexts. Everything the library does flows through one private `AnalyserNode`, so the
 * algorithm is lifted out and handed the spectrum instead. That also makes it testable in
 * node, which the package never was.
 *
 * The scoring is the original's, rule for rule. Two deliberate changes:
 * - **Time is passed in** (`nowMs`) rather than read from `performance.now()`, so the
 *   consistency rule is testable and can follow an offline render clock.
 * - **A frame with no energy at all is silence.** The original skips pushing such a frame
 *   into its history and then classifies the *previous* frame again, so the last sound
 *   before true silence was held indefinitely.
 */

type Kind = 'silence' | 'plosive' | 'fricative' | 'vowel';

const KIND: Record<OculusViseme, Kind> = {
  viseme_sil: 'silence',
  viseme_PP: 'plosive',
  viseme_FF: 'fricative',
  viseme_TH: 'fricative',
  viseme_DD: 'plosive',
  viseme_kk: 'plosive',
  viseme_CH: 'fricative',
  viseme_SS: 'fricative',
  viseme_nn: 'plosive',
  viseme_RR: 'fricative',
  viseme_aa: 'vowel',
  viseme_E: 'vowel',
  viseme_I: 'vowel',
  viseme_O: 'vowel',
  viseme_U: 'vowel',
};

/** The original's seven bands, Hz: low energy, F1 lower/mid, F2 front, F2/F3, fricatives. */
const BANDS: readonly (readonly [number, number])[] = [
  [50, 200],
  [200, 400],
  [400, 800],
  [800, 1500],
  [1500, 2500],
  [2500, 4000],
  [4000, 8000],
];

/** The original's hold: a viseme is favoured for 100 ms, then penalised as it ages. */
const MAX_VISEME_MS = 100;

export interface SpectrumFeatures {
  /** Mean of each band, 0..1. */
  readonly bands: readonly number[];
  /** Mean of the bands: the frame's loudness on the analyser's dB scale, 0..1. */
  readonly volume: number;
  /** Spectral centroid, Hz. */
  readonly centroid: number;
}

export interface Classification {
  readonly viseme: OculusViseme;
  readonly features: SpectrumFeatures;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Features of one frame of `AnalyserNode.getByteFrequencyData`, exactly as the original
 * computes them: band means over bins, and a centroid over every bin.
 */
export function spectrumFeatures(bins: ArrayLike<number>, sampleRate: number, fftSize: number): SpectrumFeatures & { energy: number } {
  const binWidth = sampleRate / fftSize;
  const bands = BANDS.map(([start, end]) => {
    const from = Math.round(start / binWidth);
    const to = Math.min(Math.round(end / binWidth), bins.length - 1);
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += bins[i] ?? 0;
    return to > from ? sum / (to - from) / 255 : 0;
  });
  let energy = 0;
  let weighted = 0;
  for (let i = 0; i < bins.length; i += 1) {
    const value = (bins[i] ?? 0) / 255;
    energy += value;
    weighted += i * binWidth * value;
  }
  return { bands, volume: mean(bands), centroid: energy > 0 ? weighted / energy : 0, energy };
}

export class VisemeClassifier {
  private readonly historySize: number;
  private readonly history: SpectrumFeatures[] = [];
  private viseme: OculusViseme = 'viseme_sil';
  private visemeStartedAt: number | null = null;

  /** `historySize` frames are averaged; Spike B ran the original with 60, its default is 10. */
  constructor(historySize = 10) {
    this.historySize = historySize;
  }

  classify(bins: ArrayLike<number>, sampleRate: number, fftSize: number, nowMs: number): Classification {
    const { energy, ...features } = spectrumFeatures(bins, sampleRate, fftSize);
    if (energy === 0) {
      this.setViseme('viseme_sil', nowMs);
      return { viseme: this.viseme, features };
    }
    this.history.push(features);
    if (this.history.length > this.historySize) this.history.shift();

    const average: SpectrumFeatures = {
      volume: mean(this.history.map((f) => f.volume)),
      centroid: mean(this.history.map((f) => f.centroid)),
      bands: BANDS.map((_, i) => mean(this.history.map((f) => f.bands[i] ?? 0))),
    };
    const scores = this.adjustForConsistency(
      scoreVisemes(features, average, features.volume - average.volume, features.centroid - average.centroid),
      nowMs,
    );

    let best: OculusViseme = 'viseme_sil';
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [viseme, score] of Object.entries(scores) as [OculusViseme, number][]) {
      if (score > bestScore) {
        bestScore = score;
        best = viseme;
      }
    }
    this.setViseme(best, nowMs);
    return { viseme: this.viseme, features };
  }

  reset(): void {
    this.history.length = 0;
    this.viseme = 'viseme_sil';
    this.visemeStartedAt = null;
  }

  private setViseme(viseme: OculusViseme, nowMs: number): void {
    if (viseme !== this.viseme || this.visemeStartedAt === null) this.visemeStartedAt = nowMs;
    this.viseme = viseme;
  }

  /** Favour the current viseme briefly, then penalise it as it ages (the original's rule). */
  private adjustForConsistency(scores: Record<OculusViseme, number>, nowMs: number): Record<OculusViseme, number> {
    const age = nowMs - (this.visemeStartedAt ?? nowMs);
    const multiplier = age <= MAX_VISEME_MS ? 1.3 : Math.max(0.5, 1 - (age - MAX_VISEME_MS) / 1000);
    return { ...scores, [this.viseme]: scores[this.viseme] * multiplier };
  }
}

function band(features: SpectrumFeatures, index: number): number {
  return features.bands[index] ?? 0;
}

/** The original's scoring rules, unchanged in order and in value. */
function scoreVisemes(
  current: SpectrumFeatures,
  average: SpectrumFeatures,
  deltaVolume: number,
  deltaCentroid: number,
): Record<OculusViseme, number> {
  const s: Record<OculusViseme, number> = {
    viseme_sil: 0,
    viseme_PP: 0,
    viseme_FF: 0,
    viseme_TH: 0,
    viseme_DD: 0,
    viseme_kk: 0,
    viseme_CH: 0,
    viseme_SS: 0,
    viseme_nn: 0,
    viseme_RR: 0,
    viseme_aa: 0,
    viseme_E: 0,
    viseme_I: 0,
    viseme_O: 0,
    viseme_U: 0,
  };

  if (average.volume < 0.2 && current.volume < 0.2) s.viseme_sil = 1;

  for (const viseme of Object.keys(KIND) as OculusViseme[]) {
    if (KIND[viseme] !== 'plosive') continue;
    if (deltaVolume < 0.01) s[viseme] -= 0.5;
    if (average.volume < 0.2) s[viseme] += 0.2;
    if (deltaCentroid > 1000) s[viseme] += 0.2;
  }

  if (current.centroid > 1000 && current.centroid < 8000) {
    if (current.centroid > 7000) s.viseme_DD += 0.6;
    else if (current.centroid > 5000) s.viseme_kk += 0.6;
    else if (current.centroid > 4000) {
      s.viseme_PP += 1;
      if (band(current, 6) > 0.25 && current.centroid < 6000) s.viseme_DD += 1.4;
    } else s.viseme_nn += 0.6;
  }

  if (
    deltaCentroid > 1000 &&
    current.centroid > 6000 &&
    average.centroid > 5000 &&
    band(current, 6) > 0.4 &&
    band(average, 6) > 0.3
  ) {
    s.viseme_FF = 0.7;
  }

  if (average.volume > 0.1 && average.centroid < 6000 && current.centroid < 6000) {
    const [b0, b1, b2, b3, b4] = [0, 1, 2, 3, 4].map((i) => band(average, i)) as [number, number, number, number, number];
    const lowSpread = Math.abs(b0 - b1);
    const midSpread = Math.max(Math.abs(b1 - b2), Math.abs(b1 - b3), Math.abs(b2 - b3));
    if (b2 > 0.1 || b3 > 0.1) {
      if (b3 > b2) {
        s.viseme_aa = 0.8;
        if (b2 > b1) s.viseme_aa += 0.2;
      }
      if (b2 > b1 && b2 > b3) s.viseme_I = 0.7;
      if (lowSpread < 0.25) s.viseme_U = 0.7;
      if (midSpread < 0.25) s.viseme_O = 0.9;
      if (b1 > b2 && b2 > b3) s.viseme_E = 1;
      if (b2 < 0.2 && b3 > 0.3) s.viseme_I = 0.7;
      if (b2 > 0.25 && b4 > 0.25) s.viseme_O = 0.7;
      if (b2 < 0.15 && b4 < 0.15) s.viseme_U = 0.7;
    }
  }
  return s;
}
