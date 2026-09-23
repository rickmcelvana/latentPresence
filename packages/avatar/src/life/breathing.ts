/**
 * A breath as a level from 0 (exhaled) to 1 (full), advanced by elapsed time.
 *
 * Phase-based so the rate can change mid-breath — listening to speaking — without the
 * chest jumping: only the speed of the phase changes, never where it is. The inhale is
 * shorter than the exhale, as it is in a person at rest, and both ends are eased, so
 * there is no corner at the top or bottom of a breath for the eye to catch.
 */
export class Breathing {
  private readonly inhaleShare: number;
  private phase: number;

  constructor(inhaleShare: number, startPhase = 0) {
    this.inhaleShare = inhaleShare;
    this.phase = startPhase % 1;
  }

  update(deltaMs: number, breathsPerMinute: number): number {
    this.phase = (this.phase + (deltaMs * breathsPerMinute) / 60_000) % 1;
    return this.level;
  }

  get level(): number {
    return breathLevel(this.phase, this.inhaleShare);
  }
}

/** The shape of one breath: phase 0..1 to level 0..1. Continuous at every point. */
export function breathLevel(phase: number, inhaleShare: number): number {
  const p = ((phase % 1) + 1) % 1;
  if (p < inhaleShare) return 0.5 - 0.5 * Math.cos((Math.PI * p) / inhaleShare);
  return 0.5 + 0.5 * Math.cos((Math.PI * (p - inhaleShare)) / (1 - inhaleShare));
}
