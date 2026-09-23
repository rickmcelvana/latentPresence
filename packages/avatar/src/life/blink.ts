import type { LifeParams } from './params';
import { type Random, between, chance, interval } from './random';

type Phase =
  | { readonly kind: 'open'; readonly nextAt: number }
  | { readonly kind: 'blinking'; readonly startedAt: number };

/**
 * When to blink, and how closed the eyes are right now.
 *
 * A blink is fast shut, a moment closed, slower open — the asymmetric shape a real one
 * has, which is why a blink on a sine reads as mechanical. Intervals are drawn around a
 * mean the caller supplies each frame, so the rate follows the conversation state without
 * the scheduler knowing what a state is. Two things break the rhythm on purpose: an
 * occasional double blink, and a blink carried by a large gaze shift (`withSaccade`),
 * which is when people blink most.
 */
export class BlinkScheduler {
  private readonly shape: LifeParams['blink'];
  private readonly random: Random;
  private now = 0;
  private phase: Phase;
  private lastEndedAt = Number.NEGATIVE_INFINITY;

  constructor(shape: LifeParams['blink'], random: Random, firstMeanMs: number) {
    this.shape = shape;
    this.random = random;
    this.phase = { kind: 'open', nextAt: interval(random, firstMeanMs, firstMeanMs * 0.6, 400) };
  }

  /** Advances time and returns the blink weight, 0 open to 1 shut. */
  update(deltaMs: number, meanIntervalMs: number): number {
    this.now += deltaMs;
    const { closeMs, holdMs, openMs } = this.shape;

    if (this.phase.kind === 'open') {
      if (this.now < this.phase.nextAt) return 0;
      this.phase = { kind: 'blinking', startedAt: this.phase.nextAt };
    }

    const t = this.now - this.phase.startedAt;
    const total = closeMs + holdMs + openMs;
    if (t >= total) {
      this.lastEndedAt = this.phase.startedAt + total;
      const gap = chance(this.random, this.shape.doubleChance)
        ? between(this.random, 60, 140)
        : interval(this.random, meanIntervalMs, meanIntervalMs * 0.6, this.shape.refractoryMs);
      this.phase = { kind: 'open', nextAt: this.lastEndedAt + gap };
      return this.update(0, meanIntervalMs);
    }
    return blinkWeight(t, closeMs, holdMs, openMs);
  }

  /**
   * A large gaze shift happened; maybe blink with it. Ignored mid-blink and inside the
   * refractory period, so a flurry of shifts cannot turn into a flutter.
   */
  withSaccade(): void {
    if (this.phase.kind !== 'open') return;
    if (this.now - this.lastEndedAt < this.shape.refractoryMs) return;
    if (!chance(this.random, this.shape.withSaccadeChance)) return;
    this.phase = { kind: 'open', nextAt: this.now };
  }
}

/** One blink's shape at `t` ms in: eased shut, held, eased open. */
export function blinkWeight(t: number, closeMs: number, holdMs: number, openMs: number): number {
  if (t <= 0) return 0;
  if (t < closeMs) return easeInOut(t / closeMs);
  if (t < closeMs + holdMs) return 1;
  const opening = (t - closeMs - holdMs) / openMs;
  return opening >= 1 ? 0 : 1 - easeInOut(opening);
}

function easeInOut(x: number): number {
  return x * x * (3 - 2 * x);
}
