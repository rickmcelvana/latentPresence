/**
 * The timing model for Spike A.
 *
 * Every number in `docs/spikes/A-voice-loop.md` comes out of here, so this file is
 * where a measurement error would turn into a wrong architectural decision. It is the
 * only part of the spike with tests.
 *
 * All marks are `performance.now()` readings — one monotonic clock, never `Date.now()`,
 * which can step backwards mid-utterance and would produce a negative interval that
 * looks like a very fast turn.
 */

/** One turn's raw marks. `null` means "not reached", never "zero". */
export interface TurnMarks {
  /** VAD crossed into speech. */
  readonly speechStart: number | null;
  /** Last frame that was speech, before the silence hangover started counting. */
  readonly speechEnd: number | null;
  /** Hangover expired; the utterance was closed and handed to STT. */
  readonly vadSettled: number | null;
  /** First text back from the recogniser. Equal to `sttDone` if it does not stream. */
  readonly sttFirstResult: number | null;
  /** Final transcript. */
  readonly sttDone: number | null;
  /** First sample scheduled on the output — not when synthesis returned. */
  readonly ttsFirstAudio: number | null;
}

export const EMPTY_MARKS: TurnMarks = {
  speechStart: null,
  speechEnd: null,
  vadSettled: null,
  sttFirstResult: null,
  sttDone: null,
  ttsFirstAudio: null,
};

/**
 * The marks a turn needs before any interval can be believed. `sttFirstResult` is not
 * among them: Moonshine through the pipeline returns once, so it is informational.
 */
export const REQUIRED_MARKS = [
  'speechStart',
  'speechEnd',
  'vadSettled',
  'sttDone',
  'ttsFirstAudio',
] as const satisfies readonly (keyof TurnMarks)[];

/** The order the marks must occur in. A turn that breaks it is not measured, it is broken. */
const ORDER = REQUIRED_MARKS;

export interface TurnTiming {
  /** How long the person spoke. Context for the other numbers, not latency. */
  readonly speechMs: number;
  /**
   * Silence the VAD waited through before closing the utterance. Tunable, and the
   * thing Smart Turn v3 (P0-T07) exists to shorten, so it is reported on its own
   * rather than buried inside the headline.
   */
  readonly hangoverMs: number;
  /** Recognition, from the utterance closing to the final transcript. */
  readonly sttMs: number;
  /** Synthesis, from final transcript to first audio out. */
  readonly ttsMs: number;
  /** The headline: end of speech to first audio. Includes the hangover. */
  readonly endToFirstAudioMs: number;
}

export type TurnResult =
  | { readonly complete: true; readonly timing: TurnTiming }
  | {
      readonly complete: false;
      readonly missing: readonly (keyof TurnMarks)[];
      readonly outOfOrder: boolean;
    };

/**
 * Turn marks into intervals, or say why it cannot.
 *
 * A turn with a dropped mark must not produce a plausible-looking number: a missing
 * `sttDone` would otherwise measure synthesis from the wrong start and read as a
 * suspiciously fast turn, which is the kind of result that gets believed.
 */
export function timeTurn(marks: TurnMarks): TurnResult {
  const missing = REQUIRED_MARKS.filter((mark) => marks[mark] === null);
  if (missing.length > 0) {
    return { complete: false, missing, outOfOrder: false };
  }

  const at = (mark: (typeof ORDER)[number]): number => marks[mark] as number;

  for (let i = 1; i < ORDER.length; i += 1) {
    const previous = ORDER[i - 1];
    const current = ORDER[i];
    if (previous === undefined || current === undefined) continue;
    if (at(current) < at(previous)) {
      return { complete: false, missing: [], outOfOrder: true };
    }
  }

  return {
    complete: true,
    timing: {
      speechMs: at('speechEnd') - at('speechStart'),
      hangoverMs: at('vadSettled') - at('speechEnd'),
      sttMs: at('sttDone') - at('vadSettled'),
      ttsMs: at('ttsFirstAudio') - at('sttDone'),
      endToFirstAudioMs: at('ttsFirstAudio') - at('speechEnd'),
    },
  };
}

/** Median of a set of readings. Even counts average the middle pair. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface RunSummary {
  readonly runs: number;
  readonly incomplete: number;
  readonly medianEndToFirstAudioMs: number | null;
  readonly worstEndToFirstAudioMs: number | null;
  readonly medianHangoverMs: number | null;
  readonly medianSttMs: number | null;
  readonly medianTtsMs: number | null;
}

/**
 * Summarise a set of turns. Incomplete turns are counted and excluded, never silently
 * dropped: ten attempts of which four failed is a different result from six good ones.
 */
export function summarise(results: readonly TurnResult[]): RunSummary {
  const complete = results.filter((result) => result.complete).map((result) => result.timing);
  return {
    runs: results.length,
    incomplete: results.length - complete.length,
    medianEndToFirstAudioMs: median(complete.map((t) => t.endToFirstAudioMs)),
    worstEndToFirstAudioMs:
      complete.length === 0 ? null : Math.max(...complete.map((t) => t.endToFirstAudioMs)),
    medianHangoverMs: median(complete.map((t) => t.hangoverMs)),
    medianSttMs: median(complete.map((t) => t.sttMs)),
    medianTtsMs: median(complete.map((t) => t.ttsMs)),
  };
}
