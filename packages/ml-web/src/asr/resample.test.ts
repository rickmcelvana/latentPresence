import { describe, expect, it } from 'vitest';
import { resample, toMono } from './resample';

/**
 * These tests are about one failure mode, and it is not "the numbers are slightly off".
 *
 * Handing a recognition model audio at the wrong rate does not throw — it transcribes
 * confidently and wrongly. So what is asserted here is the arithmetic nobody would notice
 * being wrong: that the output is the right *length*, at the right *pitch*, at the same
 * *loudness*, and that downsampling does not fold high frequencies into the speech band.
 */

/** A sine at `hz`, `seconds` long, sampled at `rate`. */
function tone(hz: number, rate: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return samples;
}

const rms = (samples: Float32Array): number => {
  let total = 0;
  for (const value of samples) total += value * value;
  return Math.sqrt(total / Math.max(samples.length, 1));
};

/**
 * Energy at `hz`, by correlating against that frequency. Enough to answer "is this tone
 * present" without an FFT, which is the only question these tests ask.
 */
function energyAt(samples: Float32Array, hz: number, rate: number): number {
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const phase = (2 * Math.PI * hz * i) / rate;
    real += (samples[i] ?? 0) * Math.cos(phase);
    imaginary += (samples[i] ?? 0) * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) / samples.length;
}

describe('resample', () => {
  it('returns the same array when the rates already match', () => {
    const samples = tone(440, 16_000, 0.1);
    expect(resample(samples, 16_000, 16_000)).toBe(samples);
  });

  it('produces the duration the new rate implies', () => {
    // The trap this catches: an off-by-a-ratio here is exactly what makes speech come out
    // three times too fast, which is the bug that reads as a bad model rather than bad audio.
    const samples = tone(440, 48_000, 0.5);
    expect(resample(samples, 48_000, 16_000)).toHaveLength(8_000);
    expect(resample(samples, 48_000, 44_100)).toHaveLength(22_050);
    expect(resample(tone(440, 16_000, 0.25), 16_000, 48_000)).toHaveLength(12_000);
  });

  it('keeps a tone at its own frequency rather than shifting it', () => {
    const source = tone(1_000, 48_000, 0.25);
    const converted = resample(source, 48_000, 16_000);
    // Present at 1 kHz, and absent at the frequency it would land on if the ratio were
    // applied to the signal instead of the timebase.
    expect(energyAt(converted, 1_000, 16_000)).toBeGreaterThan(0.4);
    expect(energyAt(converted, 3_000, 16_000)).toBeLessThan(0.02);
  });

  it('holds the loudness steady across the conversion', () => {
    const source = tone(300, 44_100, 0.3);
    const converted = resample(source, 44_100, 16_000);
    // Normalising by realised kernel weight is what buys this; without it the window's
    // truncation shows up as a gain error that varies with the ratio.
    expect(rms(converted)).toBeCloseTo(rms(source), 2);
  });

  it('low-passes rather than aliasing when it downsamples', () => {
    // 7 kHz is above the 8 kHz Nyquist of nothing — but 14 kHz is above 16 kHz's, and
    // plain linear interpolation would fold it down to 2 kHz, right into the speech band.
    const source = tone(14_000, 48_000, 0.25);
    const converted = resample(source, 48_000, 16_000);
    expect(energyAt(converted, 2_000, 16_000)).toBeLessThan(0.02);
    expect(rms(converted)).toBeLessThan(0.1);
  });

  it('passes a frequency that fits through untouched', () => {
    const source = tone(2_000, 48_000, 0.25);
    const converted = resample(source, 48_000, 16_000);
    expect(energyAt(converted, 2_000, 16_000)).toBeGreaterThan(0.4);
  });

  it('does not fade the start and end of the clip', () => {
    // Edge samples are extended rather than treated as silence. A fade here would clip the
    // first phoneme, which is where a short command's whole meaning lives.
    const flat = new Float32Array(4_800).fill(0.5);
    const converted = resample(flat, 48_000, 16_000);
    expect(converted[0]).toBeCloseTo(0.5, 3);
    expect(converted[converted.length - 1]).toBeCloseTo(0.5, 3);
  });

  it('handles an empty clip and rejects a rate that is not one', () => {
    expect(resample(new Float32Array(0), 48_000, 16_000)).toHaveLength(0);
    expect(() => resample(new Float32Array(8), 0, 16_000)).toThrow(RangeError);
    expect(() => resample(new Float32Array(8), 48_000, Number.NaN)).toThrow(RangeError);
  });
});

describe('toMono', () => {
  it('returns the same array for one channel', () => {
    const samples = new Float32Array([1, 2, 3]);
    expect(toMono(samples, 1)).toBe(samples);
  });

  it('averages interleaved channels', () => {
    const stereo = new Float32Array([1, 0, 0.5, 0.5, -1, 1]);
    expect([...toMono(stereo, 2)]).toEqual([0.5, 0.5, 0]);
  });

  it('ignores a trailing partial frame rather than inventing one', () => {
    expect(toMono(new Float32Array([1, 1, 1]), 2)).toHaveLength(1);
  });

  it('rejects a channel count that is not one', () => {
    expect(() => toMono(new Float32Array(4), 0)).toThrow(RangeError);
    expect(() => toMono(new Float32Array(4), 1.5)).toThrow(RangeError);
  });
});
