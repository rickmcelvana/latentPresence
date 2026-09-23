import type { InlineTag, SentenceTiming } from '@latentpresence/protocol';

/** A tag and when, in ms after its sentence became audible, it should happen. */
export interface Cue {
  readonly tag: InlineTag;
  readonly atMs: number;
}

/**
 * Place each tag of a sentence in its audio (P2-T07).
 *
 * A tag's `offset` indexes the spoken text (P1-T12); the time is the start of the first
 * word at or after that offset — a tag written before a word belongs to that word. With
 * backend word timings (one per whitespace-separated word, as `heardText` requires) the
 * word's own start is used; otherwise the position is interpolated by character across the
 * voiced span, which is the estimate `heardText` makes in the other direction, so the tag
 * bridge and the spoken prefix agree about where a word is.
 *
 * A tag past the last word — the model closing a sentence with `[emote:joy]` — lands at
 * the end of the voice, not in the padding after it.
 */
export function scheduleCues(text: string, tags: readonly InlineTag[], timing: SentenceTiming): Cue[] {
  const words = [...text.matchAll(/\S+/gu)].map((match) => ({ start: match.index ?? 0 }));
  const span = Math.max(0, timing.voicedEndMs - timing.voicedStartMs);
  const length = Math.max(1, text.length);
  const timed = timing.words !== undefined && timing.words.length === words.length ? timing.words : null;

  return tags.map((tag) => {
    const index = words.findIndex((word) => word.start >= tag.offset);
    if (index === -1) return { tag, atMs: timing.voicedEndMs };
    const fromTimings = timed?.[index]?.startMs;
    if (fromTimings !== undefined) return { tag, atMs: fromTimings };
    const start = words[index]?.start ?? 0;
    return { tag, atMs: Math.round(timing.voicedStartMs + (span * start) / length) };
  });
}
