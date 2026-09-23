import type { WordTiming } from '@latentpresence/protocol';

/**
 * Word timings from Kokoro's own durations (P2-T09).
 *
 * `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` returns `durations` beside `waveform`:
 * one float per input token — a pad, then one token per phoneme character, then a pad —
 * in frames of 600 samples at 24 kHz. **Measured 2026-09-23** (`docs/SURFACE.md`): rounded
 * and clamped to at least one, they sum to exactly the waveform's length over 600, so a
 * token's start is the rounded frames before it.
 *
 * **Where a word starts follows hexgrad's own `join_timestamps`** (`kokoro/pipeline.py`),
 * and the first version of this that did not was ~130 ms late on every word: the model
 * gives a stress mark real frames (3 on "ˈoʊ"), so a word starts at its first *token*, not
 * its first sounding phoneme; a space is split, half to each side; and everything moves 3
 * frames earlier than the pad says — the reference's own offset, marked TODO there, and
 * kept here because `pnpm live:cues` measured it (`docs/SURFACE.md`).
 *
 * The hard part is not the times, it is the words. The phoneme string splits into groups
 * at spaces, and a group is not a word: espeak writes "in the" as one group (`ɪnðɪ`),
 * "25" as two and "$4.50" as five, and it keeps "—" as a group of its own. Pairing by index
 * failed on four sentences of seven in the first probe. So the words of the text are
 * **aligned** to the groups — a small dynamic programme over one-to-one, one-to-many and
 * many-to-one steps, scored on how much each side has to say and on whether both end in
 * punctuation — and a group shared by several words is shared by their lengths.
 *
 * Returns one timing per whitespace-separated word of `text` (what `scheduleCues` and
 * `heardText` index by), in ms from the start of this audio; null when the durations do
 * not fit the phonemes, so the caller falls back to its estimate rather than to a guess.
 */

/** hexgrad's offset on the leading pad, in frames (`join_timestamps`: `pred_dur[0] - 3`). */
const PAD_OFFSET_FRAMES = 3;
/** Stress and length marks: they carry frames but no sound of their own, so no weight. */
const SILENT_MARKS = /[ˈˌːˑ]/u;
const PUNCTUATION = /[\p{P}\p{S}«»]/u;
/**
 * Punctuation that survives phonemisation where the text has it. A full stop does only at
 * the end of the text: espeak drops it from "U.S." and "Dr.", and counting it there pulled
 * a whole sentence one group out of line in the first version of this.
 */
const BOUNDARY = /[,;:!?…—–»"')\]]$/u;
const READ_OUT = /[\p{N}$€£%&]/u;
/** Most English letters are about one phoneme; a digit reads out as a word of three or four. */
const DIGIT_WEIGHT = 4;
/** Longest run on either side of one step: "$4.50" is five groups. */
const MAX_RUN = 6;
const RUN_PENALTY = 0.6;
/** A number or an amount is read out as several words by design, so its run is cheap. */
const READ_OUT_RUN_PENALTY = 0.1;
const SKIP_PENALTY = 2.5;
const PUNCTUATION_MISMATCH = 0.5;

interface Group {
  /** Token index (0 is the leading pad) of the group's first character. */
  readonly start: number;
  /** Token index just past the group's last character. */
  readonly end: number;
  readonly weight: number;
  readonly punctuated: boolean;
}

interface TextWord {
  readonly text: string;
  readonly weight: number;
  readonly punctuated: boolean;
  /** Digits or symbols: said as more words than are written. */
  readonly readOut: boolean;
}

function groupsOf(phonemes: readonly string[]): Group[] {
  const groups: Group[] = [];
  let first = -1;
  let weight = 0;
  const close = (end: number): void => {
    if (first === -1) return;
    const last = phonemes[end - 1] ?? '';
    // Tokens are phoneme index + 1: the leading pad is token 0.
    groups.push({ start: first + 1, end: end + 1, weight, punctuated: PUNCTUATION.test(last) });
    first = -1;
    weight = 0;
  };
  for (const [index, char] of phonemes.entries()) {
    if (char === ' ') {
      close(index);
      continue;
    }
    if (first === -1) first = index;
    if (!PUNCTUATION.test(char) && !SILENT_MARKS.test(char)) weight += 1;
  }
  close(phonemes.length);
  return groups;
}

function wordsOf(text: string): TextWord[] {
  const matches = [...text.matchAll(/\S+/gu)];
  return matches.map(([word], index) => {
    let weight = 0;
    const chars = [...word];
    for (const [at, char] of chars.entries()) {
      if (/\p{L}/u.test(char)) weight += 1;
      else if (/\p{N}/u.test(char)) weight += DIGIT_WEIGHT;
      else if (/[$€£]/u.test(char)) weight += 6; // "dollars"
      else if (char === '%') weight += 7; // "percent"
      else if (/[.,]/u.test(char) && /\p{N}/u.test(chars[at - 1] ?? '') && /\p{N}/u.test(chars[at + 1] ?? '')) weight += 3; // "and", "point"
    }
    const last = index === matches.length - 1;
    const punctuated = BOUNDARY.test(word) || (last && /[.!?]$/u.test(word));
    return { text: word, weight, punctuated, readOut: READ_OUT.test(word) };
  });
}

function stepCost(words: readonly TextWord[], groups: readonly Group[]): number {
  if (words.length === 0 || groups.length === 0) return SKIP_PENALTY;
  const said = words.reduce((sum, word) => sum + word.weight, 0);
  const spoken = groups.reduce((sum, group) => sum + group.weight, 0);
  const lastWord = words.at(-1);
  const lastGroup = groups.at(-1);
  const mismatch = lastWord !== undefined && lastGroup !== undefined && lastWord.punctuated !== lastGroup.punctuated ? PUNCTUATION_MISMATCH : 0;
  const run = words.length === 1 && words[0]?.readOut === true ? READ_OUT_RUN_PENALTY : RUN_PENALTY;
  return Math.abs(Math.log((said + 1) / (spoken + 1))) + run * (groups.length - 1) + RUN_PENALTY * (words.length - 1) + mismatch;
}

/** For each word, the groups it was aligned to: [first, last) indices, possibly shared. */
interface Span {
  readonly from: number;
  readonly to: number;
  /** Where in a shared group this word starts and ends, as fractions of it. */
  readonly share: readonly [number, number];
}

function align(words: readonly TextWord[], groups: readonly Group[]): Span[] {
  const n = words.length;
  const m = groups.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => Number.POSITIVE_INFINITY));
  const back: [number, number][][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, (): [number, number] => [0, 0]));
  cost[0]![0] = 0;
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= m; j += 1) {
      const here = cost[i]![j]!;
      if (!Number.isFinite(here)) continue;
      for (let a = 0; a <= Math.min(MAX_RUN, n - i); a += 1) {
        for (let b = 0; b <= Math.min(MAX_RUN, m - j); b += 1) {
          if (a === 0 && b === 0) continue;
          // Many words to many groups is two steps, never one.
          if (a > 1 && b > 1) continue;
          const next = here + stepCost(words.slice(i, i + a), groups.slice(j, j + b));
          if (next < cost[i + a]![j + b]!) {
            cost[i + a]![j + b] = next;
            back[i + a]![j + b] = [a, b];
          }
        }
      }
    }
  }

  const spans: Span[] = Array.from({ length: n }, () => ({ from: 0, to: 0, share: [0, 1] as const }));
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const [a, b] = back[i]![j]!;
    const from = j - b;
    if (a === 1) {
      spans[i - 1] = { from, to: j, share: [0, 1] };
    } else if (a > 1) {
      // Several words in one group: shared by how much each has to say.
      const run = words.slice(i - a, i);
      const total = Math.max(1, run.reduce((sum, word) => sum + word.weight, 0));
      let done = 0;
      for (const [k, word] of run.entries()) {
        const begin = done / total;
        done += word.weight;
        spans[i - a + k] = { from, to: from + 1, share: [begin, done / total] };
      }
    }
    i -= a;
    j -= b;
  }
  return spans;
}

export function kokoroWordTimings(
  text: string,
  phonemes: string,
  durations: ArrayLike<number>,
  samples: number,
  sampleRate: number,
): WordTiming[] | null {
  const chars = [...phonemes];
  if (durations.length !== chars.length + 2) return null;
  const frames = Array.from(durations, (d) => Math.max(1, Math.round(d)));
  const total = frames.reduce((sum, f) => sum + f, 0);
  if (total === 0 || samples === 0) return null;
  // Exact on every sentence measured; scaled anyway, so a model that rounds differently
  // stretches the times rather than running them off the end of the audio.
  const msPerFrame = ((samples / total) * 1000) / sampleRate;
  const startOf: number[] = [];
  let at = 0;
  for (const f of frames) {
    startOf.push(at);
    at += f;
  }
  startOf.push(at);
  const offset = Math.min(PAD_OFFSET_FRAMES, frames[0] ?? 0);
  const ms = (frame: number): number => Math.max(0, frame - offset) * msPerFrame;
  /** Half the space before a group's first token, or after its last: a space is shared. */
  const halfSpace = (token: number): number => (chars[token - 1] === ' ' ? (frames[token] ?? 0) / 2 : 0);

  const words = wordsOf(text);
  const groups = groupsOf(chars);
  if (words.length === 0) return [];
  if (groups.length === 0) return null;

  let lastEnd = 0;
  return align(words, groups).map((span, index) => {
    const word = words[index]!;
    const first = groups[span.from];
    const last = groups[Math.max(span.from, span.to - 1)];
    if (first === undefined || last === undefined || span.to === span.from) {
      // Said nothing espeak wrote down (a stray symbol): a zero-length word where it stands.
      return { text: word.text, startMs: Math.round(lastEnd), endMs: Math.round(lastEnd) };
    }
    const begin = ms((startOf[first.start] ?? at) - halfSpace(first.start - 1));
    const end = ms((startOf[last.end] ?? at) + halfSpace(last.end));
    const [from, to] = span.share;
    const startMs = begin + (end - begin) * from;
    const endMs = begin + (end - begin) * to;
    lastEnd = endMs;
    return { text: word.text, startMs: Math.round(startMs), endMs: Math.round(endMs) };
  });
}
