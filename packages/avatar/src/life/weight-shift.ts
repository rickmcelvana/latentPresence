import type { LifeParams } from './params';
import { type Random, between, interval } from './random';

export interface Stance {
  /** Sideways hip travel, metres, towards the character's left when positive. */
  readonly hipShift: number;
  /** Hip roll, radians. */
  readonly hipRoll: number;
  /** Spine roll: counters the hips and carries the slow sway, radians. */
  readonly spineRoll: number;
}

/**
 * A person standing still is never still: the weight settles on one leg, stays a while,
 * and moves to the other, with a slow sway under all of it.
 *
 * The stance is a number from -1 to 1 eased between values over `durationMs`, never
 * stepped, so a shift is a movement and not a pop. Each new stance goes to the other side
 * of centre from the last — people alternate legs, they do not re-plant on the same one.
 */
export class WeightShift {
  private readonly params: LifeParams['weightShift'];
  private readonly random: Random;
  private now = 0;
  private from = 0;
  private to: number;
  private startedAt = 0;
  private nextAt: number;

  constructor(params: LifeParams['weightShift'], random: Random) {
    this.params = params;
    this.random = random;
    this.to = between(random, 0.3, 1) * (random() < 0.5 ? -1 : 1);
    this.nextAt = interval(random, params.meanMs, params.meanMs * 0.5, params.durationMs * 2);
  }

  update(deltaMs: number): Stance {
    this.now += deltaMs;
    const { meanMs, durationMs, hipTravel, hipRoll, swayRoll, swayPeriodMs } = this.params;

    if (this.now >= this.nextAt) {
      this.from = this.current();
      this.to = -Math.sign(this.from || 1) * between(this.random, 0.3, 1);
      this.startedAt = this.now;
      this.nextAt = this.now + interval(this.random, meanMs, meanMs * 0.5, durationMs * 2);
    }

    const stance = this.current();
    const sway = swayRoll * Math.sin((2 * Math.PI * this.now) / swayPeriodMs);
    return {
      hipShift: stance * hipTravel,
      hipRoll: stance * hipRoll,
      spineRoll: -stance * hipRoll + sway,
    };
  }

  private current(): number {
    const t = Math.min(1, (this.now - this.startedAt) / this.params.durationMs);
    const eased = t * t * (3 - 2 * t);
    return this.from + (this.to - this.from) * eased;
  }
}
