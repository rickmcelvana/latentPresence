import { IdlePlanner, seededRandom, type IdleContext } from '@latentpresence/core';
import { IdlePerformer, type IdleFrame } from '@latentpresence/avatar';
import type { ConversationState } from '@latentpresence/protocol';
import type { Vec3 } from '@latentpresence/avatar';

/**
 * Her idle life in the call (P6-T01, ADR-50): when it has been quiet long enough, core's planner
 * chooses what she does and the avatar's performer does it; anything happening ends it at once.
 */

/** How long nothing must happen before she does anything of her own (ADR-50). */
export const IDLE_QUIET_MS = 20_000;

/** What the director reads each frame. */
export interface IdleSituation {
  readonly state: ConversationState;
  readonly pleasure: number;
  readonly energy: number;
  readonly showing: IdleContext['showing'];
  readonly now: Date;
}

export interface IdleDirectorFrame extends IdleFrame {
  /** What she is doing, in words (`IdleActivity.label`); null when nothing. */
  readonly doing: string | null;
}

export class IdleDirector {
  private readonly planner: IdlePlanner;
  private readonly performer: IdlePerformer;
  private readonly quietBeforeMs: number;
  private quietMs = 0;
  /** The quiet at which to ask the planner next. */
  private nextAt: number;
  private doing: string | null = null;

  constructor(options: { readonly planner?: IdlePlanner; readonly performer?: IdlePerformer; readonly quietBeforeMs?: number } = {}) {
    this.planner = options.planner ?? new IdlePlanner({ random: seededRandom(Date.now() >>> 0) });
    this.performer = options.performer ?? new IdlePerformer();
    this.quietBeforeMs = options.quietBeforeMs ?? IDLE_QUIET_MS;
    this.nextAt = this.quietBeforeMs;
  }

  /** Something happened — their voice, a key, her answer: stop, and start the quiet again. */
  activity(): void {
    this.quietMs = 0;
    this.nextAt = this.quietBeforeMs;
    this.performer.interrupt();
  }

  update(deltaMs: number, situation: IdleSituation, head: Vec3): IdleDirectorFrame {
    if (situation.state === 'idle') this.quietMs += deltaMs;
    else if (this.quietMs > 0 || this.performer.active) this.activity();

    if (situation.state === 'idle' && !this.performer.active && this.quietMs >= this.nextAt) {
      const context: IdleContext = { now: situation.now, quietMs: this.quietMs, pleasure: situation.pleasure, energy: situation.energy, showing: situation.showing };
      const choice = this.planner.choose(context);
      const rest = this.planner.restMs(context);
      if (choice === null) {
        this.nextAt = this.quietMs + rest;
      } else {
        this.performer.start({ ...choice.activity.perform, durationMs: choice.durationMs });
        this.doing = choice.activity.label;
        this.nextAt = this.quietMs + choice.durationMs + rest;
      }
    }

    const frame = this.performer.update(deltaMs, head);
    const doing = this.doing;
    if (frame.ended) this.doing = null;
    return { ...frame, doing };
  }
}
