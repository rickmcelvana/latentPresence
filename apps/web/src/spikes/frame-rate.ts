/**
 * The frame-rate model for Spike B.
 *
 * Every number in `docs/spikes/B-vrm-lipsync.md` comes out of here. It exists because
 * "60 fps" is the easiest claim in graphics to make and the easiest to make dishonestly:
 * an average frame rate is dominated by the frames nobody notices, and the frames people
 * do notice are the ones it hides.
 *
 * So this reports a median, a 5th percentile and the single worst frame, and it refuses
 * to report anything at all from a sample too short to mean it.
 */

/**
 * Frames discarded at the start of a window.
 *
 * The first frames after a scene loads include shader compilation, texture upload and
 * the browser settling into a rhythm. They are real costs, but they are load costs, and
 * folding them into a steady-state frame rate makes a smooth scene look stuttery.
 * Reported separately in the write-up rather than quietly dropped.
 */
export const WARM_UP_FRAMES = 30;

/** Below this many measured frames, a percentile is arithmetic rather than evidence. */
export const MINIMUM_FRAMES = 60;

export interface FrameStats {
  /** Frames used, after the warm-up was discarded. */
  readonly frames: number;
  /** The typical frame. */
  readonly medianFps: number;
  /**
   * The bad frames. One frame in twenty is worse than this, and it is the number that
   * decides whether a scene *feels* smooth — a 60 fps median with a 24 fps 5th percentile
   * is visibly stuttering.
   */
  readonly fifthPercentileFps: number;
  /** The single worst frame in the window, in milliseconds. One 80 ms frame is visible. */
  readonly worstFrameMs: number;
  readonly medianFrameMs: number;
}

/** `null` when there was not enough to say, which is not the same as a bad result. */
export type FrameResult =
  | { readonly measured: true; readonly stats: FrameStats }
  | { readonly measured: false; readonly frames: number; readonly needed: number };

/**
 * The value at a percentile, by nearest-rank on the sorted sample.
 *
 * Nearest-rank rather than interpolation: these are observed frame times, and an
 * interpolated percentile reports a frame duration that never happened.
 */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

/** Median frame time. Even counts average the middle pair. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Summarise a window of frame durations, in milliseconds.
 *
 * The 5th percentile of *frame rate* is the 95th percentile of *frame time* — the slow
 * frames. Taking the 5th percentile of the durations instead would report the fastest
 * frames under a name that promises the opposite, which is a mistake that reads as a
 * fantastic result.
 */
export function summariseFrames(
  durationsMs: readonly number[],
  warmUpFrames = WARM_UP_FRAMES,
  minimumFrames = MINIMUM_FRAMES,
): FrameResult {
  const measured = durationsMs.slice(warmUpFrames).filter((ms) => Number.isFinite(ms) && ms > 0);
  if (measured.length < minimumFrames) {
    return { measured: false, frames: measured.length, needed: minimumFrames };
  }

  const medianMs = medianOf(measured) as number;
  const slowMs = percentile(measured, 0.95) as number;
  const worstMs = Math.max(...measured);

  return {
    measured: true,
    stats: {
      frames: measured.length,
      medianFps: 1000 / medianMs,
      fifthPercentileFps: 1000 / slowMs,
      worstFrameMs: worstMs,
      medianFrameMs: medianMs,
    },
  };
}

/**
 * A rolling window of frame durations.
 *
 * Bounded so a page left open all afternoon does not report the median of an afternoon —
 * the interesting question is what the last few seconds looked like.
 */
export class FrameRecorder {
  private readonly durations: number[] = [];
  private last: number | null = null;

  private readonly capacity: number;

  // A field rather than a parameter property: `erasableSyntaxOnly` is on, so TypeScript
  // may not emit anything a plain type strip would not produce.
  constructor(capacity = 600) {
    this.capacity = capacity;
  }

  /** Feed it `performance.now()` from inside the render loop. */
  mark(now: number): void {
    if (this.last !== null) {
      this.durations.push(now - this.last);
      if (this.durations.length > this.capacity) this.durations.shift();
    }
    this.last = now;
  }

  /** Drop the window and the clock — after a resize, or a character change. */
  reset(): void {
    this.durations.length = 0;
    this.last = null;
  }

  get count(): number {
    return this.durations.length;
  }

  summary(): FrameResult {
    return summariseFrames(this.durations);
  }
}
