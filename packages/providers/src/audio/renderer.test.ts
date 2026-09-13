import { describe, expect, it } from 'vitest';
import { EDGE_RAMP_FRAMES, PlaybackRenderer, type RenderReport } from './renderer';

const RATE = 24_000;
const BLOCK = 128;

/** Render `frames` in 128-frame quanta, as the audio thread does; return every sample. */
function renderAll(renderer: PlaybackRenderer, frames: number, onBlock?: (index: number) => void) {
  const out = new Float32Array(frames);
  const reports: { at: number; report: RenderReport }[] = [];
  for (let offset = 0, index = 0; offset < frames; offset += BLOCK, index += 1) {
    onBlock?.(index);
    const block = out.subarray(offset, Math.min(offset + BLOCK, frames));
    reports.push({ at: offset, report: renderer.render(block) });
  }
  return { out, reports };
}

function tone(frames: number, amplitude = 0.5, hz = 220, phase = 0): Float32Array {
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = amplitude * Math.sin(phase + (2 * Math.PI * hz * i) / RATE);
  return samples;
}

function maxStep(samples: Float32Array): number {
  let max = 0;
  for (let i = 1; i < samples.length; i += 1) max = Math.max(max, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)));
  return max;
}

const events = (reports: { at: number; report: RenderReport }[], kind: 'started' | 'ended') =>
  reports.flatMap(({ at, report }) => report[kind].map((e) => ({ id: e.id, frame: at + e.offset })));

describe('PlaybackRenderer — the queue', () => {
  it('plays segments back to back and says where each started and ended', () => {
    const renderer = new PlaybackRenderer();
    renderer.enqueue(1, new Float32Array(300).fill(0.5));
    renderer.enqueue(2, new Float32Array(200).fill(0.5));
    const { out, reports } = renderAll(renderer, 640);

    expect(events(reports, 'started')).toEqual([
      { id: 1, frame: 0 },
      { id: 2, frame: 300 },
    ]);
    expect(events(reports, 'ended')).toEqual([
      { id: 1, frame: 300 },
      { id: 2, frame: 500 },
    ]);
    // The interior is untouched; after the queue runs dry, silence.
    expect(out[150]).toBeCloseTo(0.5);
    expect(out.subarray(500).every((v) => v === 0)).toBe(true);
    expect(renderer.pending).toBe(0);
  });

  it('ramps every segment edge from and to zero, so nothing starts or stops on a step', () => {
    const renderer = new PlaybackRenderer();
    renderer.enqueue(1, new Float32Array(1000).fill(0.8));
    const { out } = renderAll(renderer, 1280);
    expect(out[0]).toBeCloseTo(0.8 / EDGE_RAMP_FRAMES);
    expect(out[EDGE_RAMP_FRAMES - 1]).toBeCloseTo(0.8);
    expect(out[999]).toBeCloseTo(0.8 / EDGE_RAMP_FRAMES);
    expect(maxStep(out)).toBeLessThanOrEqual(0.8 / EDGE_RAMP_FRAMES + 1e-6);
  });

  it('clamps output past full scale instead of passing it to the device', () => {
    const renderer = new PlaybackRenderer();
    renderer.enqueue(1, new Float32Array(400).fill(1.043));
    renderer.enqueue(2, new Float32Array(400).fill(-1.2));
    const { out } = renderAll(renderer, 800);
    expect(Math.max(...out)).toBe(1);
    expect(Math.min(...out)).toBe(-1);
  });
});

describe('PlaybackRenderer — gain', () => {
  it('ramps a duck per sample, not per render quantum', () => {
    const renderer = new PlaybackRenderer();
    renderer.enqueue(1, new Float32Array(4800).fill(0.8));
    renderer.setGain(0.25, 720);
    const { out } = renderAll(renderer, 2400);
    // Past the edge ramp, each sample steps by the same small amount down to the target.
    const perSample = (0.8 * 0.75) / 720;
    for (let i = EDGE_RAMP_FRAMES + 1; i < 720; i += 1) {
      expect((out[i - 1] ?? 0) - (out[i] ?? 0)).toBeCloseTo(perSample, 6);
    }
    expect(out[720]).toBeCloseTo(0.2, 5);
    expect(out[2000]).toBeCloseTo(0.2, 5);
  });

  it('fades to exactly zero, drops the queue, then plays what comes next at full gain', () => {
    const renderer = new PlaybackRenderer();
    renderer.enqueue(1, new Float32Array(9600).fill(0.8));
    renderer.enqueue(2, new Float32Array(9600).fill(0.8));
    const first = renderAll(renderer, 1280);
    renderer.fade(2400);
    const faded = renderAll(renderer, 3200);

    const fadedAt = faded.reports.find(({ report }) => report.faded !== null);
    expect(fadedAt === undefined ? null : fadedAt.at + (fadedAt.report.faded ?? 0)).toBe(2400);
    expect(faded.out[2399]).toBe(0);
    expect(faded.out.subarray(2400).every((v) => v === 0)).toBe(true);
    expect(events(faded.reports, 'ended').map((e) => e.id)).toEqual([1, 2]);
    expect(first.out[1279]).toBeCloseTo(0.8);
    expect(renderer.pending).toBe(0);

    renderer.enqueue(3, new Float32Array(480).fill(0.8));
    expect(renderAll(renderer, 480).out[240]).toBeCloseTo(0.8);
  });

  it('completes a fade at once when nothing is queued', () => {
    const renderer = new PlaybackRenderer();
    renderer.fade(2400);
    const { reports } = renderAll(renderer, 128);
    expect(reports[0]?.report.faded).toBe(1);
    expect(renderer.isFading).toBe(false);
  });

  it('lets a fade win over a duck or unduck that arrives during it, and ignores a second fade', () => {
    const renderer = new PlaybackRenderer();
    renderer.enqueue(1, new Float32Array(9600).fill(0.5));
    renderAll(renderer, 256);
    renderer.fade(1200);
    renderer.setGain(1, 10);
    renderer.fade(100_000);
    const { reports } = renderAll(renderer, 1280);
    const fadedAt = reports.find(({ report }) => report.faded !== null);
    expect(fadedAt === undefined ? null : fadedAt.at + (fadedAt.report.faded ?? 0)).toBe(1200);
  });
});

describe('PlaybackRenderer — no clicks', () => {
  it('never steps further than the tone itself plus an edge ramp, through joins, a dry queue, a duck and a fade', () => {
    // A 220 Hz tone at 0.5, cut into sentences that start and end mid-cycle — the worst case
    // for a join — with a gap where the queue runs dry, then a duck, an unduck and a fade,
    // each landing in the middle of a render quantum.
    const renderer = new PlaybackRenderer();
    const sentence = (phase: number) => tone(7_111, 0.5, 220, phase);
    renderer.enqueue(1, sentence(1.1));
    renderer.enqueue(2, sentence(2.3));

    const { out } = renderAll(renderer, 60_000, (block) => {
      if (block === 130) renderer.enqueue(3, sentence(0.7)); // after a dry gap
      if (block === 150) renderer.enqueue(4, sentence(0.2));
      if (block === 160) renderer.setGain(0.25, 720);
      if (block === 175) renderer.setGain(1, 1920);
      if (block === 190) renderer.fade(2400);
      if (block === 230) renderer.enqueue(5, sentence(1.9)); // the next answer
    });

    const toneStep = maxStep(tone(24_000));
    const edgeStep = 0.5 / EDGE_RAMP_FRAMES;
    expect(maxStep(out)).toBeLessThanOrEqual(toneStep + edgeStep);
    // And the same run without the ramps would have stepped by up to the full amplitude.
    expect(toneStep + edgeStep).toBeLessThan(0.1);
  });
});
