import { DEFAULT_SPEECH_OFF, DEFAULT_SPEECH_ON } from '../turn/detector';

/**
 * When the user talking over the character becomes an interruption (P1-T08).
 *
 * The plan said: on speech start, fade out. Spike A's microphone heard the character's own
 * voice through the speakers with echo cancellation on, and a cough or a "mm-hm" is speech
 * to Silero too — so a fade on the first frame at `speechOn` throws an answer away for
 * nothing. The gate works in two stages instead:
 *
 * - **duck** on the first speech frame — the voice drops, reversibly, at once;
 * - **commit** once `bargeInMs` of speech has been heard — fade, cancel, and keep only what
 *   was said;
 * - **unduck** if the speech stops for `releaseMs` before that.
 *
 * `bargeInMs: 0` commits on the first speech frame, which is exactly the plan's rule. The
 * gate knows nothing about audio or replies: frames in, an action out.
 */

/** Speech the user has to keep up before the character stops. A starting value, not a measurement. */
export const DEFAULT_BARGE_IN_MS = 200;
/** Silence that lets a duck go. The detector's candidate window, for the same reason. */
export const DEFAULT_BARGE_IN_RELEASE_MS = 100;

export type BargeInAction = 'duck' | 'unduck' | 'commit';

export interface BargeInOptions {
  readonly bargeInMs?: number;
  readonly releaseMs?: number;
  readonly speechOn?: number;
  readonly speechOff?: number;
}

type GateState =
  | { readonly kind: 'disarmed' }
  | { readonly kind: 'listening' }
  | { readonly kind: 'ducked'; voicedMs: number; silentMs: number }
  | { readonly kind: 'committed' };

export class BargeInGate {
  readonly bargeInMs: number;
  private readonly releaseMs: number;
  private readonly speechOn: number;
  private readonly speechOff: number;
  private state: GateState = { kind: 'disarmed' };

  constructor(options: BargeInOptions = {}) {
    this.bargeInMs = options.bargeInMs ?? DEFAULT_BARGE_IN_MS;
    this.releaseMs = options.releaseMs ?? DEFAULT_BARGE_IN_RELEASE_MS;
    this.speechOn = options.speechOn ?? DEFAULT_SPEECH_ON;
    this.speechOff = options.speechOff ?? DEFAULT_SPEECH_OFF;
    if (!(this.bargeInMs >= 0)) throw new RangeError(`bargeInMs ${this.bargeInMs} must be 0 or more`);
    if (!(this.releaseMs > 0)) throw new RangeError(`releaseMs ${this.releaseMs} must be positive`);
    if (!(this.speechOff <= this.speechOn)) {
      throw new RangeError(`speechOff ${this.speechOff} must not exceed speechOn ${this.speechOn}`);
    }
  }

  /** The character is audible: start watching. */
  arm(): void {
    if (this.state.kind === 'disarmed') this.state = { kind: 'listening' };
  }

  /**
   * The character stopped. Returns `unduck` if the voice was left ducked, so the caller
   * can restore the gain for whatever plays next.
   */
  disarm(): BargeInAction | null {
    const wasDucked = this.state.kind === 'ducked';
    this.state = { kind: 'disarmed' };
    return wasDucked ? 'unduck' : null;
  }

  get ducked(): boolean {
    return this.state.kind === 'ducked';
  }

  /** One VAD frame. `durationMs` is the audio the frame covers. */
  push(probability: number, durationMs: number): BargeInAction | null {
    const state = this.state;
    switch (state.kind) {
      case 'disarmed':
      case 'committed':
        return null;
      case 'listening':
        if (probability < this.speechOn) return null;
        if (durationMs >= this.bargeInMs) {
          this.state = { kind: 'committed' };
          return 'commit';
        }
        this.state = { kind: 'ducked', voicedMs: durationMs, silentMs: 0 };
        return 'duck';
      case 'ducked':
        if (probability >= this.speechOff) {
          state.voicedMs += durationMs;
          state.silentMs = 0;
          if (state.voicedMs >= this.bargeInMs) {
            this.state = { kind: 'committed' };
            return 'commit';
          }
          return null;
        }
        state.silentMs += durationMs;
        if (state.silentMs >= this.releaseMs) {
          this.state = { kind: 'listening' };
          return 'unduck';
        }
        return null;
    }
  }
}
