import type { ConversationState } from '@latentpresence/protocol';

/**
 * The body's base clip per conversation state (P2-T03). R-12 chose from Quaternius's
 * Universal Animation Library: `Idle_Loop` for standing and listening, `Idle_Talking_Loop`
 * for speaking. Listening reuses the idle — the life layer's gaze and breathing are what
 * make her attentive — and so do thinking and an interruption, which are moments, not
 * postures worth a clip of their own until a pack has one.
 */
export type BaseClip = 'idle' | 'talk';

export const STATE_CLIPS: Readonly<Record<ConversationState, BaseClip>> = {
  idle: 'idle',
  listening: 'idle',
  thinking: 'idle',
  speaking: 'talk',
  interrupted: 'idle',
};

/**
 * Under the plan's 300 ms: long enough that a posture change never pops, short enough that
 * she has started "talking" with her body by the end of the first word.
 */
export const BASE_CROSSFADE_MS = 250;

export interface ClipChange {
  readonly clip: BaseClip;
  readonly crossfadeMs: number;
}

/**
 * Which base clip should play, told only when it changes.
 *
 * **The "only when it changes" is the point.** `ClipPlayer.play` resets the action it is
 * given, so asking for `idle` again — listening → thinking, both idle — would restart the
 * loop from frame 0 and snap the body there: exactly the pop the crossfade exists to avoid.
 */
export class BaseClipGraph {
  private current: BaseClip | null = null;

  /** The first call always answers, with no crossfade: there is nothing to fade from. */
  setState(state: ConversationState): ClipChange | null {
    const clip = STATE_CLIPS[state];
    if (clip === this.current) return null;
    const crossfadeMs = this.current === null ? 0 : BASE_CROSSFADE_MS;
    this.current = clip;
    return { clip, crossfadeMs };
  }

  /** Forget the current clip, e.g. after a new character is loaded with no clip playing. */
  reset(): void {
    this.current = null;
  }
}
