import { describe, expect, it } from 'vitest';
import {
  FrameRecorder,
  MINIMUM_FRAMES,
  WARM_UP_FRAMES,
  medianOf,
  percentile,
  summariseFrames,
} from './frame-rate';

/** A window of `count` frames at `ms` each, with `spikes` slow ones dropped in. */
function frames(count: number, ms: number, spikes: readonly number[] = []): number[] {
  const window = Array.from({ length: count }, () => ms);
  spikes.forEach((spike, i) => {
    window[Math.floor((count / (spikes.length + 1)) * (i + 1))] = spike;
  });
  return window;
}

describe('percentile', () => {
  it('returns a value that actually occurred', () => {
    // Nearest-rank rather than interpolation: these are observed frame times, and an
    // interpolated percentile reports a frame duration that never happened.
    const values = [10, 20, 30, 40];

    expect(percentile(values, 0.95)).toBe(40);
    expect(percentile(values, 0.5)).toBe(20);
    expect(values).toContain(percentile(values, 0.75));
  });

  it('has nothing to say about an empty sample', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(medianOf([])).toBeNull();
  });
});

describe('summariseFrames', () => {
  it('reports the slow frames as the fifth percentile of frame *rate*', () => {
    // The trap this guards: the 5th percentile of frame rate is the 95th percentile of
    // frame time. Taking the 5th percentile of the durations would report the fastest
    // frames under a name promising the opposite — a mistake that reads as a triumph.
    // Built explicitly rather than through the helper: exactly six of the hundred
    // measured frames are slow, so the 95th percentile of frame time lands on one of
    // them and the assertion is about the statistic, not about where a helper put them.
    const window = [
      ...frames(WARM_UP_FRAMES, 16),
      ...frames(94, 16),
      ...frames(6, 50),
    ];
    const result = summariseFrames(window);

    expect(result.measured).toBe(true);
    if (!result.measured) return;
    expect(result.stats.medianFps).toBeCloseTo(62.5, 1);
    expect(result.stats.fifthPercentileFps).toBeLessThan(result.stats.medianFps);
    expect(result.stats.fifthPercentileFps).toBeCloseTo(20, 0);
  });

  it('keeps the one visible frame that a median throws away', () => {
    const window = frames(WARM_UP_FRAMES + 100, 16, [80]);
    const result = summariseFrames(window);

    expect(result.measured).toBe(true);
    if (!result.measured) return;
    // The median is untroubled by it. That is exactly why it is reported separately.
    expect(result.stats.medianFrameMs).toBe(16);
    expect(result.stats.worstFrameMs).toBe(80);
  });

  it('discards the warm-up rather than blaming the scene for shader compilation', () => {
    const slowStart = [...frames(WARM_UP_FRAMES, 200), ...frames(100, 16)];
    const result = summariseFrames(slowStart);

    expect(result.measured).toBe(true);
    if (!result.measured) return;
    expect(result.stats.frames).toBe(100);
    expect(result.stats.worstFrameMs).toBe(16);
  });

  it('says "not measured" rather than reporting a percentile of four frames', () => {
    const result = summariseFrames(frames(WARM_UP_FRAMES + 4, 16));

    expect(result.measured).toBe(false);
    if (result.measured) return;
    expect(result.frames).toBe(4);
    expect(result.needed).toBe(MINIMUM_FRAMES);
  });

  it('ignores frames that are not durations', () => {
    // A tab going to the background produces a multi-second gap, and a paused clock can
    // produce a zero. Neither is a rendered frame.
    const window = [...frames(WARM_UP_FRAMES + 100, 16), Number.NaN, 0, -5];
    const result = summariseFrames(window);

    expect(result.measured).toBe(true);
    if (!result.measured) return;
    expect(result.stats.frames).toBe(100);
  });
});

describe('FrameRecorder', () => {
  it('measures the gaps between marks, not the marks', () => {
    const recorder = new FrameRecorder();
    for (let i = 0; i <= 200; i += 1) recorder.mark(i * 16);

    // 201 marks give 200 gaps. The first mark starts the clock and is not a frame.
    expect(recorder.count).toBe(200);
    const result = recorder.summary();
    expect(result.measured).toBe(true);
    if (!result.measured) return;
    expect(result.stats.medianFrameMs).toBe(16);
  });

  it('keeps a bounded window so an afternoon does not average away a bad minute', () => {
    const recorder = new FrameRecorder(50);
    for (let i = 0; i <= 500; i += 1) recorder.mark(i * 16);

    expect(recorder.count).toBe(50);
  });

  it('forgets the clock on reset, so a resize does not log one enormous frame', () => {
    const recorder = new FrameRecorder();
    recorder.mark(0);
    recorder.mark(16);
    recorder.reset();
    recorder.mark(9000);

    expect(recorder.count).toBe(0);
  });
});
