/**
 * Clicks, measured rather than listened for (P1-T08).
 *
 * The plan's done-when is "a manual test shows no audio clicks". Rick's ear is the final
 * word, but an ear hears a click and cannot say where it came from, and the Browser pane
 * has no ears at all. A click is a discontinuity: a sample-to-sample step far larger than
 * the signal around it takes. So the harness records exactly what the worklet rendered and
 * this compares the largest step near each event that *could* click — a sentence starting
 * or ending, a duck, an unduck, a fade — against the steps the voice itself took **in the
 * 50 ms just before it**.
 *
 * The baseline is local on purpose. The first version compared against the 99.9th percentile
 * of the whole recording, and Kokoro's sibilants put that at 0.32 — so a hard cut on a
 * voiced sample at 0.3 would have scored under 1 and passed. The voice right before an event
 * is what a discontinuity has to stand out from.
 */

export type MarkKind = 'start' | 'end' | 'duck' | 'unduck' | 'fade';

export interface Mark {
  readonly kind: MarkKind;
  /** Frame index into the recording. */
  readonly frame: number;
}

export interface MarkReport {
  readonly kind: MarkKind;
  readonly frame: number;
  /** Largest |step| within `windowFrames` either side. */
  readonly maxStep: number;
  /** Largest |step| in the 50 ms before the window: the voice's own movement there. */
  readonly baseline: number;
  /** `maxStep` over `baseline`. Over `threshold` is a click. */
  readonly ratio: number;
  readonly click: boolean;
  /** For a fade: ms from the mark until the output is exactly zero and stays so for 50 ms. Null otherwise, or never. */
  readonly silentAfterMs: number | null;
}

export interface OutputReport {
  readonly frames: number;
  readonly peak: number;
  /** Frames at exactly ±1: the clamp did work. */
  readonly clamped: number;
  /** 99.9th percentile of |step| over frames with signal in them. */
  readonly speechStep: number;
  readonly marks: readonly MarkReport[];
  readonly clicks: number;
}

/** 5 ms at 24 kHz either side of an event. */
export const DEFAULT_WINDOW_FRAMES = 120;
/** 50 ms at 24 kHz of voice before the window, to measure it against. */
export const BASELINE_FRAMES = 1200;
/**
 * Twice the largest step of the preceding 50 ms. A duck or fade only ever makes steps
 * smaller, so a well-behaved event scores under 1; a hard cut on a voiced sample scores
 * many times over.
 */
export const DEFAULT_CLICK_RATIO = 2;
/** Below this the local voice is silence, and a step of this size is inaudible anyway. */
const QUIET_STEP = 0.01;

export function analyseOutput(
  samples: Float32Array,
  marks: readonly Mark[],
  options: { windowFrames?: number; threshold?: number } = {},
): OutputReport {
  const windowFrames = options.windowFrames ?? DEFAULT_WINDOW_FRAMES;
  const threshold = options.threshold ?? DEFAULT_CLICK_RATIO;

  let peak = 0;
  let clamped = 0;
  const steps: number[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    const magnitude = Math.abs(value);
    peak = Math.max(peak, magnitude);
    if (magnitude >= 1) clamped += 1;
    if (i > 0) {
      const previous = samples[i - 1] ?? 0;
      if (magnitude > 0.01 || Math.abs(previous) > 0.01) steps.push(Math.abs(value - previous));
    }
  }
  steps.sort((a, b) => a - b);
  const speechStep = steps.length === 0 ? 0 : (steps[Math.min(steps.length - 1, Math.floor(steps.length * 0.999))] ?? 0);

  const step = (i: number): number => Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0));
  const reports = marks.map((mark): MarkReport => {
    const at = Math.floor(mark.frame);
    const from = Math.max(1, at - windowFrames);
    const to = Math.min(samples.length - 1, at + windowFrames);
    let maxStep = 0;
    for (let i = from; i <= to; i += 1) maxStep = Math.max(maxStep, step(i));
    let baseline = 0;
    for (let i = Math.max(1, from - BASELINE_FRAMES); i < from; i += 1) baseline = Math.max(baseline, step(i));
    const ratio = maxStep / Math.max(baseline, QUIET_STEP);

    let silentAfterMs: number | null = null;
    if (mark.kind === 'fade') {
      let run = 0;
      for (let i = Math.max(0, at); i < samples.length; i += 1) {
        run = samples[i] === 0 ? run + 1 : 0;
        if (run >= BASELINE_FRAMES) {
          silentAfterMs = ((i - BASELINE_FRAMES + 1 - at) / 24_000) * 1000;
          break;
        }
      }
    }
    return { kind: mark.kind, frame: mark.frame, maxStep, baseline, ratio, click: ratio > threshold, silentAfterMs };
  });

  return {
    frames: samples.length,
    peak,
    clamped,
    speechStep,
    marks: reports,
    clicks: reports.filter((report) => report.click).length,
  };
}

/** Concatenate recorded blocks into one buffer. */
export function joinBlocks(blocks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}
