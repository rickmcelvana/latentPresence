import type { ConversationState } from '@latentpresence/protocol';
import type { PlaybackSink } from '../playback/sink';
import {
  DEFAULT_SPEECH_OFF,
  DEFAULT_SPEECH_ON,
  DEFAULT_TURN_THRESHOLD,
  type TurnEvent,
  type VadFrame,
} from '../turn/detector';
import type { BackchannelClip } from './clips';

/**
 * When the character says "yeah" while the user is still talking (P1-T09, ADR-28).
 *
 * **Where one goes.** `TurnDetector` offers a candidate at every pause of `candidateMs`
 * and emits `judged` when Smart Turn answers while that pause is still going. An answer
 * under the turn threshold means *this sounds unfinished* — the user is mid-thought and
 * the floor is still theirs — which is exactly where a listener backchannels. So a clip
 * plays on a `judged` below the threshold, and only then, if all of these hold:
 *
 * - the conversation is `listening` — never while the character is thinking, speaking or
 *   fading out, where a backchannel would be talking over itself;
 * - nothing is playing, and the last clip started at least `intervalMs` ago (the plan's
 *   "at most once per 8 s");
 * - the turn has carried `minSpeechMs` of speech before this pause. R-2 found Smart Turn
 *   scoring a short, complete question 0.01–0.02 three times in four; the hangover then
 *   ends the turn and an answer follows, so a backchannel there would sit between the
 *   question and its answer. A short utterance is rarely one that wants a backchannel.
 *
 * **Never started over user speech.** A `judged` is only emitted for a pause that is still
 * silent, so a clip cannot *start* over speech. The user can start again while it plays, and
 * in practice nearly always does: a clip starts ~210 ms into a pause, a pause the turn
 * survives is under the 512 ms hangover, and every word here is longer than the ~300 ms
 * left. The first frame the detector would call speech — `speechOff` inside an open turn,
 * `speechOn` once it has ended — therefore **ducks** the clip to the barge-in level and lets
 * the word finish, restoring the gain when it ends. Cutting it instead left "Ye—" in the
 * browser (ADR-28); `overlap: 'cut'` fades it out over `cutMs`, the plan's literal rule.
 *
 * No timers and no DOM; time is the frames' clock.
 */

export const DEFAULT_BACKCHANNEL_INTERVAL_MS = 8000;
/** Speech in the turn before a pause may be backchannelled. A starting value, for an ear. */
export const DEFAULT_BACKCHANNEL_MIN_SPEECH_MS = 3000;
/** With `overlap: 'cut'`, a clip fades this fast. The duck's own ramp is 30 ms; this is a word, not an answer. */
export const DEFAULT_BACKCHANNEL_CUT_MS = 50;

export interface BackchannelOptions {
  readonly intervalMs?: number;
  readonly minSpeechMs?: number;
  /** What a clip does when the user speaks into it: `duck` and finish (default), or `cut`. */
  readonly overlap?: 'duck' | 'cut';
  readonly cutMs?: number;
  /** The detector's turn threshold: a pause judged at or over it is a turn end, not a pause. */
  readonly threshold?: number;
  readonly speechOn?: number;
  readonly speechOff?: number;
  /** In [0, 1). Picks the clip; injected so tests are deterministic. */
  readonly random?: () => number;
}

export type BackchannelEvent =
  | { readonly type: 'played'; readonly text: string; readonly at: number }
  /** The user spoke into a clip. `action` is what was done about it. */
  | { readonly type: 'overlapped'; readonly action: 'duck' | 'cut'; readonly text: string; readonly at: number };

interface Playing {
  readonly id: number;
  readonly clip: BackchannelClip;
  overlapped: 'duck' | 'cut' | null;
}

export class BackchannelScheduler {
  readonly intervalMs: number;
  readonly minSpeechMs: number;
  readonly overlap: 'duck' | 'cut';
  readonly cutMs: number;
  private readonly sink: PlaybackSink;
  private readonly clips: readonly BackchannelClip[];
  private readonly threshold: number;
  private readonly speechOn: number;
  private readonly speechOff: number;
  private readonly random: () => number;
  private readonly detach: () => void;

  private turn: { readonly speechStartAt: number; open: boolean } | null = null;
  /** The live candidate's end of speech, by id, so `judged` knows how long the user spoke. */
  private candidate: { readonly id: number; readonly speechEndAt: number } | null = null;
  private playing: Playing | null = null;
  private lastPlayedAt: number | null = null;
  private lastClip = -1;

  constructor(sink: PlaybackSink, clips: readonly BackchannelClip[], options: BackchannelOptions = {}) {
    this.sink = sink;
    this.clips = clips;
    this.intervalMs = options.intervalMs ?? DEFAULT_BACKCHANNEL_INTERVAL_MS;
    this.minSpeechMs = options.minSpeechMs ?? DEFAULT_BACKCHANNEL_MIN_SPEECH_MS;
    this.overlap = options.overlap ?? 'duck';
    this.cutMs = options.cutMs ?? DEFAULT_BACKCHANNEL_CUT_MS;
    this.threshold = options.threshold ?? DEFAULT_TURN_THRESHOLD;
    this.speechOn = options.speechOn ?? DEFAULT_SPEECH_ON;
    this.speechOff = options.speechOff ?? DEFAULT_SPEECH_OFF;
    this.random = options.random ?? Math.random;
    if (!(this.intervalMs >= 0)) throw new RangeError(`intervalMs ${this.intervalMs} must be 0 or more`);
    if (!(this.minSpeechMs >= 0)) throw new RangeError(`minSpeechMs ${this.minSpeechMs} must be 0 or more`);
    if (!(this.cutMs > 0)) throw new RangeError(`cutMs ${this.cutMs} must be positive`);
    this.detach = sink.subscribe((event) => {
      if (event.type === 'ended' && event.id === this.playing?.id) this.finished(this.playing);
    });
  }

  /** Whether a clip is queued or audible. */
  get active(): boolean {
    return this.playing !== null;
  }

  /** A turn event, with the conversation's state as it arrives. Returns a clip it started. */
  onTurn(event: TurnEvent<unknown>, state: ConversationState): BackchannelEvent | null {
    switch (event.type) {
      case 'speech-start':
        this.turn = { speechStartAt: event.at, open: true };
        this.candidate = null;
        return null;
      case 'candidate':
        this.candidate = { id: event.candidateId, speechEndAt: event.speechEndAt };
        return null;
      case 'turn-end':
        if (this.turn !== null) this.turn.open = false;
        this.candidate = null;
        return null;
      case 'turn-resumed':
        // Same turn, same start (ADR-25); the detector keeps `speechStartAt` too.
        if (this.turn !== null) this.turn.open = true;
        return null;
      case 'judged':
        return this.consider(event.candidateId, event.probability, event.at, state);
      default:
        return null;
    }
  }

  /** One microphone frame. Returns `overlapped` if the user spoke into a clip. */
  push(frame: VadFrame): BackchannelEvent | null {
    const playing = this.playing;
    if (playing === null || playing.overlapped !== null) return null;
    const speech = this.turn?.open === true ? this.speechOff : this.speechOn;
    if (frame.probability < speech) return null;
    playing.overlapped = this.overlap;
    if (this.overlap === 'duck') {
      this.sink.duck();
    } else {
      // A fade restores the gain itself once it is silent.
      void this.sink.fadeOut(this.cutMs).then(() => {
        if (this.playing === playing) this.playing = null;
      });
    }
    return { type: 'overlapped', action: this.overlap, text: playing.clip.text, at: frame.at };
  }

  dispose(): void {
    this.detach();
    if (this.playing !== null) this.finished(this.playing);
  }

  /** The clip is over: give back the gain a duck took, before whatever plays next. */
  private finished(playing: Playing): void {
    this.playing = null;
    if (playing.overlapped === 'duck') this.sink.unduck();
  }

  private consider(candidateId: number, probability: number, at: number, state: ConversationState): BackchannelEvent | null {
    if (state !== 'listening' || this.clips.length === 0 || this.playing !== null) return null;
    if (probability >= this.threshold) return null;
    const turn = this.turn;
    const candidate = this.candidate;
    if (turn === null || !turn.open || candidate === null || candidate.id !== candidateId) return null;
    if (candidate.speechEndAt - turn.speechStartAt < this.minSpeechMs) return null;
    if (this.lastPlayedAt !== null && at - this.lastPlayedAt < this.intervalMs) return null;

    const index = this.pick();
    const clip = this.clips[index];
    if (clip === undefined) return null;
    // A copy each time: the sink may transfer the buffer, and the clip is played again.
    const id = this.sink.enqueue({ samples: clip.samples.slice(), sampleRate: clip.sampleRate });
    this.playing = { id, clip, overlapped: null };
    this.lastPlayedAt = at;
    this.lastClip = index;
    return { type: 'played', text: clip.text, at };
  }

  /** Any clip but the last one, when there is a choice. */
  private pick(): number {
    const count = this.clips.length;
    if (count === 1 || this.lastClip < 0) return Math.min(count - 1, Math.floor(this.random() * count));
    const index = Math.min(count - 2, Math.floor(this.random() * (count - 1)));
    return index >= this.lastClip ? index + 1 : index;
  }
}
