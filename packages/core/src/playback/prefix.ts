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

/** How much silence to keep either side of the voice when trimming a sentence. */
export interface EdgePadding {
  readonly leadMs: number;
  readonly tailMs: number;
}

/**
 * Kokoro pads every sentence with ~310 ms of silence in front and ~490 ms behind, in the
 * browser and in node alike (P1-T08, `docs/SURFACE.md`). Played as synthesised, the first
 * audible word of an answer arrives a third of a second after its first frame — latency
 * the listener hears, against a 500 ms budget (ADR-20) — and sentences sit ~0.8 s apart.
 *
 * The lead keeps 50 ms because a soft onset ("f", "h") starts under the voiced threshold;
 * the tail keeps 250 ms, so two sentences meet with ~300 ms between them, inside the range
 * of a spoken pause. Both are starting values for an ear to judge (ADR-27).
 */
export const DEFAULT_EDGE_PADDING: EdgePadding = { leadMs: 50, tailMs: 250 };

/**
 * Cut a sentence down to its voice plus `padding`. Returns a copy, where the voice sits
 * within it, and `trimmedFrom`, the frame of the original the copy starts at — which a
 * backend's word timings, measured on the original, must be moved by. Never lengthens:
 * padding past the audio's own edges is not invented.
 */
export function trimToVoice(
  samples: Float32Array,
  sampleRate: number,
  padding: EdgePadding = DEFAULT_EDGE_PADDING,
  threshold = DEFAULT_VOICED_THRESHOLD,
): { readonly samples: Float32Array; readonly voicedStart: number; readonly voicedEnd: number; readonly trimmedFrom: number } {
  const voiced = voicedRange(samples, threshold);
  const from = Math.max(0, voiced.start - Math.round((padding.leadMs / 1000) * sampleRate));
  const to = Math.min(samples.length, voiced.end + Math.round((padding.tailMs / 1000) * sampleRate));
  return { samples: samples.slice(from, to), voicedStart: voiced.start - from, voicedEnd: voiced.end - from, trimmedFrom: from };
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
