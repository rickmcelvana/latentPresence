/**
 * The output side of a conversation, as the reply controller sees it (P1-T08).
 *
 * The browser implements this over an AudioWorklet (`packages/providers/src/audio`);
 * tests implement it in twenty lines. Nothing here touches Web Audio, which is what lets
 * the controller that decides *what was heard* be tested with no audio at all.
 *
 * **The unit is a whole sentence.** Both TTS providers deliver one sentence as one block
 * (ADR-24: nothing streams within a sentence), so the queue never runs dry in the middle
 * of a word — it can only run dry between sentences, where the renderer ramps each
 * segment's edges to zero. A backend that streams inside a sentence is concatenated
 * before it gets here.
 */

/** One sentence of mono PCM. The sink may transfer the buffer: do not read it afterwards. */
export interface PlaybackSegment {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

export type PlaybackEvent =
  /**
   * The segment's first frame was rendered. `at` is when it reaches the listener, in ms on
   * the sink's clock: the render time plus the output latency.
   */
  | { readonly type: 'started'; readonly id: number; readonly at: number }
  /** The segment's last frame was rendered, or it was dropped by a fade. */
  | { readonly type: 'ended'; readonly id: number; readonly at: number };

/** Where playback is: a frame of a segment, counted in that segment's own sample rate. */
export interface PlaybackPosition {
  readonly id: number;
  readonly frame: number;
}

export interface PlaybackSink {
  /** Queue a sentence behind whatever is queued. Returns the id its events carry. */
  enqueue(segment: PlaybackSegment): number;
  /** The first stage of barge-in: turn the voice down, reversibly. */
  duck(): void;
  unduck(): void;
  /**
   * Fade to silence over `ms`, then drop everything queued and restore the gain for the
   * next reply. Resolves once silent. Calling it again while a fade runs returns the same
   * promise, so the machine and the controller can both ask.
   */
  fadeOut(ms: number): Promise<void>;
  /** The segment being rendered and how far into it, or null when nothing is. */
  position(): PlaybackPosition | null;
  subscribe(listener: (event: PlaybackEvent) => void): () => void;
}
