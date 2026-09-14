import { useEffect, useRef, useState } from 'react';
import type { ConversationEvent } from '@latentpresence/protocol';
import { emptyTranscript, reduceTranscript, type TranscriptLine, type TranscriptState } from '@latentpresence/core';

/**
 * Folds a machine's events through `reduceTranscript` (P1-T11) and hands the panel
 * `state.lines`, so `/chat` and `/dev/voice` share one hook rather than each owning the
 * reducer loop. `subscribe` is `ConversationMachine.subscribe` (or anything with the same
 * shape) — the hook never talks to a machine directly, so a test can hand it a fake.
 */
export interface UseTranscriptResult {
  readonly lines: readonly TranscriptLine[];
  /** Empties the panel's lines. Does not stop an answer, end the session, or touch the
   * model's history — this is the panel's view, not the conversation (memory is P4). */
  readonly clear: () => void;
}

export function useTranscript(subscribe: (listener: (event: ConversationEvent) => void) => () => void): UseTranscriptResult {
  const state = useRef<TranscriptState>(emptyTranscript());
  const [lines, setLines] = useState<readonly TranscriptLine[]>([]);

  useEffect(
    () =>
      subscribe((event) => {
        state.current = reduceTranscript(state.current, event);
        setLines(state.current.lines);
      }),
    [subscribe],
  );

  function clear(): void {
    state.current = emptyTranscript();
    setLines(state.current.lines);
  }

  return { lines, clear };
}
