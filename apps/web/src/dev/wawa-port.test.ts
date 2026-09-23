import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lipsync } from 'wawa-lipsync';
import { VisemeClassifier, createRandom } from '@latentpresence/avatar';

/**
 * P2-T04 ported wawa-lipsync's classifier rather than using the package (it cannot attach
 * to a node in another AudioContext). This holds the port to the original: both classify
 * the same frames, and every viseme must match.
 *
 * Here and not in `packages/avatar` because the original is only a devDependency of this
 * app (Spike B), and it needs a `window.AudioContext` — stubbed below with an analyser
 * that hands back whichever frame the test is on, and a clock the test moves.
 */

const SAMPLE_RATE = 24_000;
const FFT_SIZE = 1024;

let frame: Uint8Array = new Uint8Array(FFT_SIZE / 2);
let now = 0;

class StubAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  getByteFrequencyData(into: Uint8Array): void {
    into.set(frame.subarray(0, into.length));
  }
  connect(): void {}
}

class StubAudioContext {
  readonly sampleRate = SAMPLE_RATE;
  createAnalyser(): StubAnalyser {
    return new StubAnalyser();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Speech-shaped frames: a spectral tilt with a couple of formant bumps that move, loudness
 * that rises and falls, the odd hiss (fricative) and the odd near-silent frame — enough to
 * reach the silence, plosive, fricative and every vowel branch of the scoring.
 */
function frames(count: number, seed: number): Uint8Array[] {
  const random = createRandom(seed);
  const binWidth = SAMPLE_RATE / FFT_SIZE;
  const out: Uint8Array[] = [];
  let f1 = 500;
  let f2 = 1500;
  for (let n = 0; n < count; n += 1) {
    f1 = Math.min(900, Math.max(250, f1 + (random() - 0.5) * 120));
    f2 = Math.min(2600, Math.max(800, f2 + (random() - 0.5) * 300));
    const loud = random() < 0.1 ? 0.05 : 0.3 + 0.7 * Math.abs(Math.sin(n / 9));
    const hiss = random() < 0.15;
    const bins = new Uint8Array(FFT_SIZE / 2);
    for (let i = 1; i < bins.length; i += 1) {
      const hz = i * binWidth;
      const tilt = Math.exp(-hz / 2500);
      const formants = Math.exp(-((hz - f1) ** 2) / 40_000) + 0.7 * Math.exp(-((hz - f2) ** 2) / 90_000);
      const noise = hiss ? 0.6 * Math.exp(-((hz - 6000) ** 2) / 4_000_000) : 0;
      bins[i] = Math.min(255, Math.round(255 * loud * (0.35 * tilt + 0.6 * formants + noise) + random() * 6));
    }
    bins[1] = Math.max(bins[1] ?? 0, 1); // never a zero-energy frame: that is the one deliberate change
    out.push(bins);
  }
  return out;
}

describe('the wawa-lipsync port', () => {
  it('classifies every frame as the original does', () => {
    vi.stubGlobal('AudioContext', StubAudioContext);
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    const original = new Lipsync({ fftSize: FFT_SIZE, historySize: 10 });
    const port = new VisemeClassifier(10);
    const seen = new Set<string>();
    let compared = 0;

    for (const bins of frames(6000, 42)) {
      frame = bins;
      now += 1000 / 60;
      original.processAudio();
      const ours = port.classify(bins, SAMPLE_RATE, FFT_SIZE, now);
      expect(ours.viseme).toBe(String(original.viseme));
      expect(ours.features.volume).toBeCloseTo(original.features?.volume ?? Number.NaN, 12);
      expect(ours.features.centroid).toBeCloseTo(original.features?.centroid ?? Number.NaN, 9);
      seen.add(ours.viseme);
      compared += 1;
    }

    expect(compared).toBe(6000);
    // The comparison is only worth something if it reached most of the rules.
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });
});
