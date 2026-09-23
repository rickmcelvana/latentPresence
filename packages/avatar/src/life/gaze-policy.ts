import type { GazeTarget } from '@latentpresence/protocol';
import type { GazeOffset } from '../gaze';
import type { LifeParams, MoodParams } from './params';
import { type Random, between, chance, interval } from './random';

export interface GazeChoice {
  readonly target: GazeTarget;
  readonly offset: GazeOffset;
  /** True on the frame the target changed — a saccade big enough to carry a blink. */
  readonly shifted: boolean;
}

/**
 * Where the eyes go: a base target, looks away from it, and the return.
 *
 * The base is what the conversation wants — the user, almost always; the affect engine can
 * move it later (`AffectDirective.gaze`). On the base the eyes are not still: they hop
 * between nearby points every second or so, as eyes on a face go from eye to eye to
 * mouth, and a gaze that never does this is the "stare" people notice first. Away from it,
 * a look lasts a while and comes back — drift and return. How often, how long and where to
 * are the mood's (`MoodParams`), read every decision so a state change applies at the next
 * one rather than cutting a glance short.
 */
export class GazePolicy {
  private readonly params: LifeParams['gaze'];
  private readonly random: Random;
  private now = 0;
  private base: GazeTarget = 'user';
  private target: GazeTarget = 'user';
  private offset: GazeOffset = [0, 0];
  private decideAt: number;
  private hopAt: number;

  constructor(params: LifeParams['gaze'], random: Random, mood: MoodParams) {
    this.params = params;
    this.random = random;
    this.decideAt = interval(random, mood.holdMeanMs, mood.holdMeanMs * 0.6, 500);
    this.hopAt = interval(random, params.fixationHopMeanMs, params.fixationHopMeanMs * 0.6, 200);
  }

  /** Where the eyes rest when nothing draws them away. Takes effect immediately. */
  setBase(base: GazeTarget): boolean {
    if (base === this.base) return false;
    const wasOnBase = this.target === this.base;
    this.base = base;
    if (!wasOnBase) return false;
    this.target = base;
    this.offset = [0, 0];
    return true;
  }

  update(deltaMs: number, mood: MoodParams): GazeChoice {
    this.now += deltaMs;
    let shifted = false;

    if (this.now >= this.decideAt) {
      const onBase = this.target === this.base;
      const candidates = mood.awayTargets.filter((target) => target !== this.base);
      if (onBase && candidates.length > 0 && chance(this.random, mood.lookAwayChance)) {
        const next = candidates[Math.floor(this.random() * candidates.length)] ?? this.base;
        shifted = next !== this.target;
        this.target = next;
        const jitter = this.params.awayJitter;
        this.offset = [between(this.random, -jitter, jitter), between(this.random, -jitter, jitter) / 2];
        this.decideAt = this.now + interval(this.random, mood.awayMeanMs, mood.awayMeanMs * 0.6, 300);
      } else {
        shifted = !onBase;
        this.target = this.base;
        if (!onBase) this.offset = this.fixation();
        this.decideAt = this.now + interval(this.random, mood.holdMeanMs, mood.holdMeanMs * 0.6, 500);
      }
    }

    if (this.target === this.base && this.now >= this.hopAt) {
      this.offset = this.fixation();
      const mean = this.params.fixationHopMeanMs;
      this.hopAt = this.now + interval(this.random, mean, mean * 0.6, 200);
    }

    return { target: this.target, offset: this.offset, shifted };
  }

  /** A point on the face: within the radius, flattened, since eyes and mouth are a band. */
  private fixation(): GazeOffset {
    const radius = this.params.fixationRadius;
    const angle = this.random() * Math.PI * 2;
    const distance = radius * Math.sqrt(this.random());
    return [Math.cos(angle) * distance, Math.sin(angle) * distance * 0.7];
  }
}
