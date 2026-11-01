import type { ConversationEvent } from '@latentpresence/protocol';

/**
 * The captions reducer (P9-T01, ADR-67): what is being **said aloud**, one line at a time,
 * for someone who cannot hear her. Pure, in `reduceTranscript`'s style, so the stage and a
 * test read the same rules.
 *
 * Her caption is the sentence the voice is playing, not the one the model last wrote: a
 * sentence's text is kept on `assistant.sentence` and shown on its `assistant.audio.started`.
 * A typed reply nobody hears has no caption — there is no sound to caption, and the
 * transcript has the words. Their own words show once recognised (`user.transcript`), so
 * they can see what she heard; typed messages and backchannels (ADR-28) do not.
 */

export interface Caption {
  readonly speaker: 'her' | 'you';
  readonly text: string;
  /** Her caption's sentence, for matching its `assistant.audio.ended`; null for theirs. */
  readonly sentenceIndex: number | null;
  /** When the words stopped (ms since the epoch), or null while they are still going. */
  readonly endedAt: number | null;
}

export interface CaptionState {
  readonly caption: Caption | null;
  /** Sentences written but not yet heard, by index. */
  readonly pending: ReadonlyMap<number, string>;
}

/** How long a caption stays once its words have ended. */
export const CAPTION_HOLD_MS = 3000;

export function emptyCaptions(): CaptionState {
  return { caption: null, pending: new Map() };
}

function atMs(at: string): number {
  return new Date(at).getTime();
}

/** Apply one event. Pure: returns a new state, or the same one when nothing changed. */
export function reduceCaptions(state: CaptionState, event: ConversationEvent): CaptionState {
  switch (event.type) {
    case 'assistant.sentence': {
      const pending = new Map(state.pending);
      pending.set(event.index, event.text);
      return { ...state, pending };
    }

    case 'assistant.audio.started': {
      const text = state.pending.get(event.sentenceIndex);
      if (text === undefined) return state;
      const pending = new Map(state.pending);
      pending.delete(event.sentenceIndex);
      return { caption: { speaker: 'her', text, sentenceIndex: event.sentenceIndex, endedAt: null }, pending };
    }

    case 'assistant.audio.ended': {
      const { caption } = state;
      if (caption?.speaker !== 'her' || caption.sentenceIndex !== event.sentenceIndex || caption.endedAt !== null) return state;
      return { ...state, caption: { ...caption, endedAt: atMs(event.at) } };
    }

    case 'assistant.message':
      // The answer is settled: whatever was written and never played (a typed reply with no
      // voice out) is not going to be heard now. Sentence indexes start again with the next.
      return state.pending.size === 0 ? state : { ...state, pending: new Map() };

    case 'assistant.interrupted':
      // The rest of the sentence was never said, and nor will the rest of the answer be.
      return { caption: state.caption?.speaker === 'her' ? null : state.caption, pending: new Map() };

    case 'user.transcript': {
      if (event.text.trim() === '') return state;
      return { ...state, caption: { speaker: 'you', text: event.text, sentenceIndex: null, endedAt: event.isFinal ? atMs(event.at) : null } };
    }

    default:
      return state;
  }
}

/** The caption to show at `nowMs`, or null once it has been held long enough. */
export function visibleCaption(state: CaptionState, nowMs: number): Caption | null {
  const { caption } = state;
  if (caption === null) return null;
  if (caption.endedAt !== null && nowMs - caption.endedAt >= CAPTION_HOLD_MS) return null;
  return caption;
}
