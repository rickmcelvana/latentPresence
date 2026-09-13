import type { WordTiming } from '@latentpresence/protocol';

/**
 * What the user heard of an answer that was cut off (P1-T08).
 *
 * `assistant.interrupted` carries a `spokenPrefix`, and the transcript and memory keep
 * that rather than the whole generated answer: the rest was never said. Neither real TTS
 * provider returns word timings (P1-T05), so for them the prefix is an **estimate** from
 * how much of the sentence's audio was rendered. The estimate is deliberately
 * conservative: a word counts only once its estimated *end* has played, because a memory
 * that says the character told the user something they never heard is worse than one
 * that drops a half-spoken word.
 *
 * **What "heard" means.** Everything the renderer produced before the fade's midpoint.
 * The output latency delays when those frames reach the listener; it does not stop them
 * arriving, so it is not subtracted here.
 */

/** Absolute level under which a sample is treated as silence at a sentence's edges. */
export const DEFAULT_VOICED_THRESHOLD = 0.02;

/**
 * The frames of a sentence that carry the voice: `[start, end)`. TTS pads a sentence with
 * silence at both ends, and spreading the words across that padding would put every word
 * boundary late at the start and early at the end.
 */
export function voicedRange(
  samples: Float32Array,
  threshold = DEFAULT_VOICED_THRESHOLD,
): { readonly start: number; readonly end: number } {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start] ?? 0) < threshold) start += 1;
  if (start === samples.length) return { start: 0, end: samples.length };
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1] ?? 0) < threshold) end -= 1;
  return { start, end };
}

/** One sentence of an answer, as the estimator needs to know it. */
export interface SpokenSentence {
  readonly text: string;
  /** Length of the sentence's audio, in frames at `sampleRate`. */
  readonly frames: number;
  readonly sampleRate: number;
  /** From `voicedRange`; the whole sentence when omitted. */
  readonly voicedStart?: number;
  readonly voicedEnd?: number;
  /** Backend word timings, in ms from the start of the sentence's audio. Used when present. */
  readonly words?: readonly WordTiming[];
}

interface Token {
  readonly end: number;
}

function tokens(text: string): Token[] {
  return [...text.matchAll(/\S+/gu)].map((match) => ({ end: (match.index ?? 0) + match[0].length }));
}

/**
 * The words of one sentence whose end had been rendered by `heardFrames`, as the prefix of
 * its text they form. Proportional by character across the voiced range unless the backend
 * supplied timings for the same words.
 */
export function heardText(sentence: SpokenSentence, heardFrames: number): string {
  if (heardFrames >= sentence.frames) return sentence.text;
  if (heardFrames <= 0) return '';
  const words = tokens(sentence.text);
  if (words.length === 0) return '';

  const timings = sentence.words;
  if (timings !== undefined && timings.length === words.length) {
    let count = 0;
    for (const timing of timings) {
      if ((timing.endMs / 1000) * sentence.sampleRate > heardFrames) break;
      count += 1;
    }
    return count === 0 ? '' : sentence.text.slice(0, words[count - 1]?.end ?? 0);
  }

  const start = sentence.voicedStart ?? 0;
  const end = sentence.voicedEnd ?? sentence.frames;
  const length = sentence.text.length;
  let heardTo = 0;
  for (const word of words) {
    const wordEnd = start + ((end - start) * word.end) / length;
    if (wordEnd > heardFrames) break;
    heardTo = word.end;
  }
  return sentence.text.slice(0, heardTo);
}

/**
 * The prefix of a whole answer: every sentence before `index` in full, and the heard part
 * of sentence `index` at `frame`. A `frame` past the sentence's end runs on into the next
 * one, which is how the second half of a fade that crosses a sentence boundary is counted.
 */
export function spokenPrefix(
  sentences: readonly SpokenSentence[],
  heard: { readonly index: number; readonly frame: number } | null,
): string {
  if (heard === null) return '';
  const parts: string[] = [];
  let index = heard.index;
  let frame = heard.frame;
  for (let i = 0; i < index && i < sentences.length; i += 1) {
    parts.push(sentences[i]?.text ?? '');
  }
  while (index < sentences.length) {
    const sentence = sentences[index];
    if (sentence === undefined) break;
    if (frame < sentence.frames) {
      parts.push(heardText(sentence, frame));
      break;
    }
    parts.push(sentence.text);
    const next = sentences[index + 1];
    if (next === undefined) break;
    // Seconds past this sentence, re-expressed in the next one's rate.
    frame = ((frame - sentence.frames) / sentence.sampleRate) * next.sampleRate;
    index += 1;
  }
  return parts.filter((part) => part !== '').join(' ');
}
