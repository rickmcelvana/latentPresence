import { describe, expect, it } from 'vitest';
import { VisemeClassifier } from './classifier';
import { LipSync, type SpectrumSource } from './lipsync';
import { DEFAULT_MOUTH_PARAMS, MouthDriver, type MouthWeights, visemeAt } from './mouth';

const FRAME = 1000 / 60;

function total(weights: MouthWeights): number {
  return [...weights.values()].reduce((sum, w) => sum + w, 0);
}

/** A source whose next frame the test sets. */
function source(): SpectrumSource & { frame: Uint8Array } {
  const state = {
    sampleRate: 24_000,
    fftSize: 1024,
    frame: new Uint8Array(512),
    read(into: Uint8Array): void {
      into.set(state.frame);
    },
  };
  return state;
}

/**
 * A vowel-ish frame at ordinary speaking level: energy in the F1/F2 bands, and a volume
 * near the 0.43 median P2-T04 measured on Kokoro speech.
 */
function vowel(): Uint8Array {
  const bins = new Uint8Array(512);
  const binWidth = 24_000 / 1024;
  for (let i = 1; i < bins.length; i += 1) {
    const hz = i * binWidth;
    bins[i] = Math.min(255, Math.round(255 * (Math.exp(-((hz - 700) ** 2) / 60_000) + 0.8 * Math.exp(-((hz - 1200) ** 2) / 90_000)) + 120 * Math.exp(-hz / 4000)));
  }
  return bins;
}

describe('MouthDriver', () => {
  it('opens within a few frames of a sound starting', () => {
    const mouth = new MouthDriver();
    let weights = mouth.update('viseme_aa', 0.6, FRAME);
    for (let i = 0; i < 2; i += 1) weights = mouth.update('viseme_aa', 0.6, FRAME);
    expect(weights.get('aa')).toBeGreaterThan(0.7);
  });

  it('is half shut within one release half-life of the sound stopping, and shut soon after', () => {
    const mouth = new MouthDriver();
    for (let i = 0; i < 30; i += 1) mouth.update('viseme_aa', 0.6, FRAME);
    const open = mouth.update('viseme_aa', 0.6, FRAME).get('aa') ?? 0;
    const half = mouth.update('viseme_sil', 0, DEFAULT_MOUTH_PARAMS.releaseMs).get('aa') ?? 0;
    expect(half).toBeCloseTo(open / 2, 5);
    let weights = mouth.update('viseme_sil', 0, FRAME);
    for (let i = 0; i < 8; i += 1) weights = mouth.update('viseme_sil', 0, FRAME);
    expect(total(weights)).toBeLessThan(0.05);
  });

  it('blends one vowel into the next rather than cutting', () => {
    const mouth = new MouthDriver();
    for (let i = 0; i < 20; i += 1) mouth.update('viseme_aa', 0.6, FRAME);
    const weights = mouth.update('viseme_O', 0.6, FRAME);
    expect(weights.get('aa')).toBeGreaterThan(0.1);
    expect(weights.get('oh')).toBeGreaterThan(0.1);
  });

  it('never opens wider in total than the cap', () => {
    const mouth = new MouthDriver();
    for (let i = 0; i < 200; i += 1) {
      const weights = mouth.update(i % 2 === 0 ? 'viseme_aa' : 'viseme_E', 1, FRAME);
      expect(total(weights)).toBeLessThanOrEqual(DEFAULT_MOUTH_PARAMS.maxTotal + 1e-9);
    }
  });

  it('stays shut below the floor and on a closed-lip sound', () => {
    const mouth = new MouthDriver();
    expect(total(mouth.update('viseme_aa', DEFAULT_MOUTH_PARAMS.floor, FRAME))).toBe(0);
    expect(total(mouth.update('viseme_PP', 0.9, FRAME))).toBe(0);
  });
});

describe('visemeAt — the word-timing path', () => {
  const words = [
    { text: 'Hello', startMs: 0, endMs: 400 },
    { text: 'world', startMs: 500, endMs: 900 },
  ];

  it('is shut between words and after the last', () => {
    expect(visemeAt(words, 450).viseme).toBe('viseme_sil');
    expect(visemeAt(words, 950).volume).toBe(0);
  });

  it('walks the vowels of a word across its duration', () => {
    expect(visemeAt(words, 50).viseme).toBe('viseme_E'); // hEllo
    expect(visemeAt(words, 350).viseme).toBe('viseme_O'); // hellO
    expect(visemeAt(words, 600).viseme).toBe('viseme_O'); // wOrld
  });
});

describe('VisemeClassifier', () => {
  it('calls a frame with no energy silence, even straight after a sound', () => {
    const classifier = new VisemeClassifier();
    classifier.classify(vowel(), 24_000, 1024, 0);
    expect(classifier.classify(new Uint8Array(512), 24_000, 1024, FRAME).viseme).toBe('viseme_sil');
  });

  it('reads the speaking-level fixture at speaking level', () => {
    const volume = new VisemeClassifier().classify(vowel(), 24_000, 1024, 0).features.volume;
    expect(volume).toBeGreaterThan(0.38);
    expect(volume).toBeLessThan(0.6);
  });

  it('hears a loud formant-shaped frame as a vowel', () => {
    const classifier = new VisemeClassifier();
    let viseme = '';
    for (let i = 0; i < 12; i += 1) viseme = classifier.classify(vowel(), 24_000, 1024, i * FRAME).viseme;
    expect(['viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U']).toContain(viseme);
  });
});

describe('LipSync', () => {
  it('opens on the voice and closes when it stops', () => {
    const voice = source();
    const lips = new LipSync(voice);
    voice.frame = vowel();
    let weights: MouthWeights = new Map();
    for (let i = 0; i < 12; i += 1) weights = lips.update(FRAME, i * FRAME);
    expect(total(weights)).toBeGreaterThan(0.5);
    voice.frame = new Uint8Array(512);
    for (let i = 12; i < 24; i += 1) weights = lips.update(FRAME, i * FRAME);
    expect(total(weights)).toBeLessThan(0.05);
  });

  it('follows word timings while they last, then goes back to the analyser', () => {
    const voice = source();
    const lips = new LipSync(voice);
    lips.useTimings([{ text: 'saw', startMs: 0, endMs: 300 }], 1000);
    let weights: MouthWeights = new Map();
    for (let t = 1000; t < 1200; t += FRAME) weights = lips.update(FRAME, t);
    // The analyser hears silence; only the timeline can have opened the mouth.
    expect(weights.get('aa')).toBeGreaterThan(0.5);
    for (let t = 1300; t < 1600; t += FRAME) weights = lips.update(FRAME, t);
    expect(total(weights)).toBeLessThan(0.05);
  });
});
