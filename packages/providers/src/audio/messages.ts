/**
 * The contract between the playback worklet and `BrowserAudioOutput` (P1-T08). Times are
 * the AudioContext clock in seconds, taken inside the worklet at the frame they describe.
 */

export const PLAYBACK_PROCESSOR = 'latentpresence-playback';
export const CAPTURE_PROCESSOR = 'latentpresence-capture';

export type PlaybackRequest =
  /** Samples at the context's rate. Transferred. */
  | { readonly type: 'enqueue'; readonly id: number; readonly samples: Float32Array }
  | { readonly type: 'gain'; readonly target: number; readonly frames: number }
  | { readonly type: 'fade'; readonly frames: number }
  /** Post every rendered block back, for measuring the output itself. Off by default. */
  | { readonly type: 'record'; readonly on: boolean };

export type PlaybackResponse =
  | { readonly type: 'started'; readonly id: number; readonly time: number }
  | { readonly type: 'ended'; readonly id: number; readonly time: number }
  | { readonly type: 'faded'; readonly time: number }
  | { readonly type: 'recorded'; readonly samples: Float32Array; readonly time: number };

/** What the driver needs of an `AudioWorkletNode`'s port. Structural, so tests need no DOM. */
export interface PlaybackPort {
  post(message: PlaybackRequest, transfer?: readonly Transferable[]): void;
  onMessage(listener: (message: PlaybackResponse) => void): () => void;
}

/** One microphone frame out of the capture worklet: `frameSamples` at the context's rate. */
export interface CaptureMessage {
  readonly samples: Float32Array;
  /** Context time of the frame's first sample. */
  readonly time: number;
}
