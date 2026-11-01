import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ConversationEvent } from '@latentpresence/protocol';
import { CAPTION_HOLD_MS, emptyCaptions, reduceCaptions, visibleCaption, type Caption, type CaptionState } from '@latentpresence/core';

export interface CaptionsProps {
  readonly characterName: string;
  /** `ConversationMachine.subscribe`, or a fake with the same shape. */
  readonly subscribe: (listener: (event: ConversationEvent) => void) => () => void;
  /** A test seam for the hold; `Date.now` otherwise. */
  readonly now?: () => number;
}

/**
 * Captions on the stage (P9-T01, ADR-67): what is being said aloud, as it is heard. Not a
 * live region — the transcript's `log` is what a screen reader follows, and announcing the
 * caption as well would read every sentence twice, over her voice.
 */
export function Captions({ characterName, subscribe, now = Date.now }: CaptionsProps): ReactElement | null {
  const state = useRef<CaptionState>(emptyCaptions());
  const [caption, setCaption] = useState<Caption | null>(null);

  useEffect(
    () =>
      subscribe((event) => {
        const next = reduceCaptions(state.current, event);
        if (next === state.current) return;
        state.current = next;
        setCaption(visibleCaption(next, now()));
      }),
    [subscribe, now],
  );

  // Once the words have ended, take the caption down after the hold.
  const endedAt = caption?.endedAt ?? null;
  useEffect(() => {
    if (endedAt === null) return;
    const timer = setTimeout(() => setCaption(visibleCaption(state.current, now())), Math.max(0, endedAt + CAPTION_HOLD_MS - now()));
    return () => clearTimeout(timer);
  }, [endedAt, now]);

  if (caption === null) return null;
  return (
    <p className="call-captions" data-testid="captions">
      <span className="call-captions-speaker">{caption.speaker === 'her' ? characterName : 'You'}</span>
      {caption.text}
    </p>
  );
}
