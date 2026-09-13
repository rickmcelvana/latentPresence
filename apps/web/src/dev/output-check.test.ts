import { describe, expect, it } from 'vitest';
import { analyseOutput, joinBlocks } from './output-check';

const RATE = 24_000;

function voice(frames: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = 0.4 * Math.sin((2 * Math.PI * 180 * i) / RATE) + 0.1 * Math.sin((2 * Math.PI * 900 * i) / RATE);
  return out;
}

describe('analyseOutput', () => {
  it('finds no click where the voice fades smoothly', () => {
    const samples = voice(24_000);
    // A 100 ms linear fade from frame 12 000.
    for (let i = 12_000; i < 24_000; i += 1) samples[i] = (samples[i] ?? 0) * Math.max(0, 1 - (i - 12_000) / 2400);
    const report = analyseOutput(samples, [{ kind: 'fade', frame: 12_000 }]);
    expect(report.clicks).toBe(0);
    expect(report.marks[0]?.ratio).toBeLessThanOrEqual(1.01);
    expect(report.marks[0]?.silentAfterMs).toBeCloseTo(100, 0);
  });

  it('flags a hard cut even when the recording elsewhere has steps larger than the cut', () => {
    const samples = voice(48_000);
    // A burst of hiss early on: large steps that a whole-recording percentile would learn from.
    for (let i = 2000; i < 6000; i += 1) samples[i] = i % 2 === 0 ? 0.45 : -0.45;
    let cut = 36_000;
    while (Math.abs(samples[cut] ?? 0) < 0.3) cut += 1;
    samples.fill(0, cut);
    const report = analyseOutput(samples, [{ kind: 'fade', frame: cut }]);
    expect(report.speechStep).toBeGreaterThan(0.3);
    expect(report.clicks).toBe(1);
  });

  it('reports a fade that never reaches silence', () => {
    const report = analyseOutput(voice(24_000), [{ kind: 'fade', frame: 12_000 }]);
    expect(report.marks[0]?.silentAfterMs).toBeNull();
  });

  it('flags a hard cut on a voiced sample', () => {
    const samples = voice(24_000);
    // Find a frame near the tone's crest and cut there.
    let cut = 12_000;
    while (Math.abs(samples[cut] ?? 0) < 0.3) cut += 1;
    samples.fill(0, cut);
    const report = analyseOutput(samples, [{ kind: 'fade', frame: cut }]);
    expect(report.clicks).toBe(1);
    expect(report.marks[0]?.ratio).toBeGreaterThan(3);
  });

  it('only looks near the marks, so a click elsewhere is not blamed on them', () => {
    const samples = voice(24_000);
    samples[20_000] = 0.9;
    const report = analyseOutput(samples, [{ kind: 'start', frame: 1000 }]);
    expect(report.clicks).toBe(0);
  });

  it('counts clamped frames and reports the peak', () => {
    const samples = new Float32Array([0, 0.5, 1, -1, 0.2]);
    const report = analyseOutput(samples, []);
    expect(report.peak).toBe(1);
    expect(report.clamped).toBe(2);
  });

  it('joins recorded blocks in order', () => {
    expect([...joinBlocks([new Float32Array([1, 2]), new Float32Array([3])])]).toEqual([1, 2, 3]);
  });
});
