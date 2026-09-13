/**
 * The playback queue's inner loop, with no Web Audio in it (P1-T08).
 *
 * `playback.worklet.ts` is a dozen lines around this class; everything that decides what a
 * speaker cone does — the queue, the gain ramps, the fade, the clamp — lives here, where a
 * node test can read every sample it writes. A click is a discontinuity in the output, and
 * each place one could come from is handled per sample:
 *
 * - **segment edges** ramp from and to zero over `EDGE_RAMP_FRAMES`, so a sentence that
 *   does not begin or end at rest, and a queue that runs dry between sentences, cannot step;
 * - **gain changes** (duck, unduck, fade) are linear ramps advanced once per sample, never
 *   once per render quantum, which at 24 kHz would be a 5.3 ms staircase;
 * - **the fade** reaches exactly zero before the queue is dropped, so nothing is cut while
 *   audible;
 * - **the clamp**: Kokoro peaks past full scale (1.043, `docs/SURFACE.md`), and a value past
 *   ±1 is the output device's problem to wrap or clip in ways nobody chose.
 *
 * The renderer imports nothing, because the worklet bundle it goes into should be small and
 * must not drag a package barrel into the audio thread.
 */

/** 2 ms at 24 kHz: inaudible on speech, and enough to take any edge to rest. */
export const EDGE_RAMP_FRAMES = 48;

export interface RenderReport {
  /** Segments whose first frame was written, with the offset into this block. */
  readonly started: { readonly id: number; readonly offset: number }[];
  /** Segments whose last frame was written, or that a fade dropped, with the offset after it. */
  readonly ended: { readonly id: number; readonly offset: number }[];
  /** The offset at which a fade reached silence and the queue was dropped, or null. */
  readonly faded: number | null;
}

interface Queued {
  readonly id: number;
  readonly samples: Float32Array;
  read: number;
}

export class PlaybackRenderer {
  private readonly queue: Queued[] = [];
  private gain = 1;
  private target = 1;
  private step = 0;
  /** Frames left in the current ramp. Counted, not compared: float steps drift off target. */
  private rampLeft = 0;
  private fading = false;

  /** Frames still to be written, across every queued segment. */
  get pending(): number {
    return this.queue.reduce((sum, item) => sum + item.samples.length - item.read, 0);
  }

  get isFading(): boolean {
    return this.fading;
  }

  enqueue(id: number, samples: Float32Array): void {
    this.queue.push({ id, samples, read: 0 });
  }

  /** Ramp the gain to `target` over `frames`. Ignored while a fade runs: the fade wins. */
  setGain(target: number, frames: number): void {
    if (this.fading) return;
    this.rampTo(target, frames);
  }

  /**
   * Ramp to silence over `frames`, then drop everything queued and restore unity gain for
   * whatever is queued next. With nothing queued there is nothing to fade: it completes on
   * the next rendered frame.
   */
  fade(frames: number): void {
    if (this.fading) return;
    this.fading = true;
    if (this.queue.length === 0) {
      this.rampTo(0, 0);
      return;
    }
    this.rampTo(0, frames);
  }

  render(out: Float32Array): RenderReport {
    const started: { id: number; offset: number }[] = [];
    const ended: { id: number; offset: number }[] = [];
    let faded: number | null = null;

    for (let i = 0; i < out.length; i += 1) {
      let sample = 0;
      const current = this.queue[0];
      if (current !== undefined) {
        const { samples, read } = current;
        if (read === 0) started.push({ id: current.id, offset: i });
        const edge = Math.min(1, (read + 1) / EDGE_RAMP_FRAMES, (samples.length - read) / EDGE_RAMP_FRAMES);
        sample = (samples[read] ?? 0) * edge;
        current.read = read + 1;
        if (current.read >= samples.length) {
          ended.push({ id: current.id, offset: i + 1 });
          this.queue.shift();
        }
      }

      if (this.rampLeft > 0) {
        this.rampLeft -= 1;
        this.gain = this.rampLeft === 0 ? this.target : this.gain + this.step;
      }

      const value = sample * this.gain;
      out[i] = value > 1 ? 1 : value < -1 ? -1 : value;

      if (this.fading && this.gain === 0) {
        for (const dropped of this.queue.splice(0)) ended.push({ id: dropped.id, offset: i + 1 });
        this.fading = false;
        this.rampTo(1, 0);
        faded = i + 1;
        out.fill(0, i + 1);
        break;
      }
    }
    return { started, ended, faded };
  }

  private rampTo(target: number, frames: number): void {
    this.target = target;
    if (frames <= 0 || this.gain === target) {
      this.gain = target;
      this.step = 0;
      this.rampLeft = 0;
      return;
    }
    this.step = (target - this.gain) / frames;
    this.rampLeft = frames;
  }
}
