import type { CharacterEmotion } from '@latentpresence/protocol';

/**
 * The sentence chunker (P1-T04): LLM tokens in, TTS-sized chunks out.
 *
 * Three jobs, in one pass so the stream is only walked once:
 * split a token stream into sentences or clauses small enough that the first one can be
 * synthesised while the rest is still arriving; lift `[emote:x]` and `[gesture:x]` tags
 * out of the spoken text into events carrying the offset where they sat; and refuse to
 * split where a split would be wrong — inside an abbreviation, a decimal, a URL, a code
 * span, or an emoji.
 *
 * The chunker is pure text and holds no protocol type but `CharacterEmotion`, so it runs
 * in a worker, in the companion, or in a test with no DOM and no clock.
 */

/** Which inline tag this is. P1-T12 writes the persona text that asks for them. */
export type InlineTagKind = 'emote' | 'gesture';

/**
 * A tag lifted out of the spoken text.
 *
 * `offset` is an index into the **chunk's own `text`**, after tags are removed — the
 * position the tag sat at in what the user will actually hear. That is the only offset
 * P2 can use: it schedules the expression or clip against TTS word timestamps, which
 * are measured over spoken text and know nothing about markup.
 */
export interface InlineTag {
  readonly kind: InlineTagKind;
  /** The raw label, e.g. `joy` or `shrug`. Validity is `known`'s business, not ours. */
  readonly value: string;
  /**
   * For an `emote`, the label when it is one of the twelve `CharacterEmotion`s, else
   * null. A model will invent labels; dropping those silently would lose a gesture the
   * avatar could still have played, and passing them on as valid would make P2 map
   * something it has no preset for.
   */
  readonly known: CharacterEmotion | null;
  /** Index into the chunk's `text` where the tag was removed. */
  readonly offset: number;
}

/** One unit of speech, the thing TTS is asked for and `assistant.sentence` carries. */
export interface SpeechChunk {
  /** 0-based, monotonic for the life of the chunker; matches `assistant.sentence.index`. */
  readonly index: number;
  /** Tag-free, whitespace-normalised, never empty and never whitespace-only. */
  readonly text: string;
  readonly tags: readonly InlineTag[];
}

export interface SentenceChunkerOptions {
  /**
   * Hard ceiling on a chunk. A sentence longer than this is split at the last clause
   * mark, else the last space, else the character limit — because time-to-first-audio
   * matters more than prosody on a run-on sentence, and an unterminated code fence must
   * not buffer a whole turn.
   */
  readonly maxChars?: number;
}

/** What ends a sentence. Exported so a test can hold it against the set below. */
export const terminators = new Set(['.', '!', '?', '。', '！', '？']);

/** CJK sentence marks carry their own spacing: nothing follows them but the next
 * sentence, so demanding whitespace after one would never split Japanese at all. */
export const selfSpacingTerminators = new Set(['。', '！', '？']);

/** Punctuation that belongs to the sentence it closes: `He said "go." Then left.` */
const CLOSERS = new Set(['"', "'", ')', ']', '}', '»', '”', '’']);

/** Where a too-long sentence is allowed to break. */
const CLAUSE_MARKS = new Set([',', ';', ':', '—', '–']);

/**
 * Words that end in a period without ending a sentence. Single letters are handled
 * separately and cover far more: `e.g.`, `i.e.`, `U.S.`, `J. R. R. Tolkien`.
 *
 * The cost of a wrong entry is under-splitting — two sentences spoken as one — which is
 * a prosody nit. The cost of a missing entry is a chunk cut at `Dr.`, which TTS renders
 * as a full stop and a pause in the middle of a name. The list is therefore generous.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'hon', 'st', 'sr', 'jr',
  'vs', 'etc', 'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'fig', 'no',
  'approx', 'al', 'cf', 'viz', 'ca', 'circa', 'min', 'max', 'vol', 'ch',
  'pp', 'ed', 'eds', 'univ', 'assn', 'bros', 'mt', 'ft', 'rd', 'ave',
  'blvd', 'apt', 'sq', 'gen', 'col', 'sgt', 'capt', 'lt', 'pres', 'gov',
]);

/**
 * The labels `CharacterEmotion` allows, as a plain runtime set so the hot path is a
 * lookup rather than a zod parse. The duplication is only safe because
 * `chunker.test.ts` asserts this set equals `CharacterEmotionSchema.options`: without
 * that test a thirteenth emotion would be reported `known: null` and the avatar would
 * silently lose an expression it can play.
 */
export const knownEmotions = new Set<string>([
  'neutral', 'joy', 'affection', 'amusement', 'curiosity', 'surprise',
  'concern', 'sadness', 'frustration', 'embarrassment', 'pride', 'relief',
]);

/**
 * A `[` that is not closed within this many characters is literal text, not the start of
 * a tag. Without the cap an unmatched bracket would hold the rest of the turn in the
 * buffer waiting for a `]` that never arrives.
 */
const TAG_SCAN_LIMIT = 48;

const TAG_PATTERN = /^\[(emote|gesture):([a-z][a-z0-9-]*)\]/;

const isWhitespace = (ch: string): boolean => ch.length > 0 && /\s/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isLetter = (ch: string): boolean => /\p{L}/u.test(ch);

/** True when cutting here would split a surrogate pair — an emoji rendered as mojibake. */
const isLowSurrogate = (ch: string): boolean => {
  const code = ch.codePointAt(0);
  return code !== undefined && code >= 0xdc00 && code <= 0xdfff;
};

/**
 * Splits a stream of LLM tokens into speech chunks.
 *
 * Push tokens as they arrive; each call returns the chunks that became *certain* as a
 * result. Certainty is the whole difference between this and splitting a finished
 * string: `Hello.` is not a sentence end until something follows it, because the next
 * token may be `5 kilometres`. Call `flush()` once the stream ends to release whatever
 * is still held.
 */
export class SentenceChunker {
  private readonly maxChars: number;
  /** Raw text not yet consumed. Only ever a partial tag or a trailing backtick run. */
  private buffer = '';
  /** Tag-free text of the chunk being built. Never starts with whitespace. */
  private spoken = '';
  /** Offsets into `spoken` where a sentence terminator was seen outside code. */
  private candidates: number[] = [];
  /** Offsets where a chunk must end whatever the punctuation says: a fence edge. */
  private forced: number[] = [];
  private tags: InlineTag[] = [];
  private trailing: InlineTag[] = [];
  private nextIndex = 0;
  private inFence = false;
  private inCode = false;

  constructor(options: SentenceChunkerOptions = {}) {
    this.maxChars = options.maxChars ?? 200;
  }

  /**
   * Tags that arrived after the last spoken character, so no chunk could carry them —
   * `Nice to meet you! [gesture:wave]`. Read after `flush()`. They are kept rather than
   * dropped because a closing wave is exactly the gesture a model emits there.
   */
  get trailingTags(): readonly InlineTag[] {
    return this.trailing;
  }

  /** Feed one token (or any string). Returns the chunks it completed, often none. */
  push(token: string): SpeechChunk[] {
    this.buffer += token;
    this.consume(false);
    return this.drain(false);
  }

  /** End of stream: consume what is held and release the last chunk. */
  flush(): SpeechChunk[] {
    this.consume(true);
    return this.drain(true);
  }

  /** Move text out of `buffer` into `spoken`, lifting tags and tracking code state. */
  private consume(final: boolean): void {
    let i = 0;
    while (i < this.buffer.length) {
      const ch = this.buffer.charAt(i);

      if (ch === '`') {
        let run = 0;
        while (this.buffer.charAt(i + run) === '`') run += 1;
        // A run at the very end may still be growing: `` may become ```.
        if (!final && i + run >= this.buffer.length && run < 3) break;
        if (run >= 3) {
          // A code block is its own chunk: prose and code do not share one, because
          // TTS needs the boundary and P1-T11's transcript wants to render them apart.
          if (!this.inFence) this.forced.push(this.spoken.length);
          this.inFence = !this.inFence;
          for (let k = 0; k < run; k += 1) this.append('`');
          if (!this.inFence) this.forced.push(this.spoken.length);
        } else {
          if (run === 1 && !this.inFence) this.inCode = !this.inCode;
          for (let k = 0; k < run; k += 1) this.append('`');
        }
        i += run;
        continue;
      }

      if (ch === '[' && !this.inCode && !this.inFence) {
        const rest = this.buffer.slice(i, i + TAG_SCAN_LIMIT);
        const match = TAG_PATTERN.exec(rest);
        if (match !== null) {
          const kind = match[1] === 'gesture' ? 'gesture' : 'emote';
          const value = match[2] ?? '';
          this.tags.push({
            kind,
            value,
            known: kind === 'emote' && knownEmotions.has(value) ? (value as CharacterEmotion) : null,
            offset: this.spoken.length,
          });
          i += match[0].length;
          // `Hello [emote:joy] world` must not become `Hello  world`.
          while (isWhitespace(this.buffer.charAt(i)) && this.endsWithSpace()) i += 1;
          continue;
        }
        // No match: either it is not a tag, or the tag has not finished arriving.
        if (!rest.includes(']') && rest.length < TAG_SCAN_LIMIT && !final) break;
        this.append('[');
        i += 1;
        continue;
      }

      this.append(ch);
      if (!this.inCode && !this.inFence && terminators.has(ch)) {
        this.candidates.push(this.spoken.length - 1);
      }
      i += 1;
    }
    this.buffer = this.buffer.slice(i);
  }

  private endsWithSpace(): boolean {
    return this.spoken.length > 0 && isWhitespace(this.spoken.charAt(this.spoken.length - 1));
  }

  /**
   * Append one character, normalising whitespace outside code: runs collapse to a single
   * space and a chunk never begins with one, which keeps every recorded offset honest
   * after a tag is lifted out.
   */
  private append(ch: string): void {
    if (!isWhitespace(ch)) {
      this.spoken += ch;
      return;
    }
    if (this.spoken.length === 0) return;
    if (this.inCode || this.inFence) {
      this.spoken += ch;
      return;
    }
    if (this.endsWithSpace()) return;
    this.spoken += ' ';
  }

  /** Emit every chunk that is now certain. */
  private drain(final: boolean): SpeechChunk[] {
    const out: SpeechChunk[] = [];
    for (;;) {
      let cut = this.findBoundary(final);
      if (cut === null && this.spoken.length >= this.maxChars) cut = this.forceCut();
      if (cut === null) break;
      const chunk = this.take(cut);
      if (chunk !== null) out.push(chunk);
    }
    if (final) {
      const chunk = this.take(this.spoken.length);
      if (chunk !== null) out.push(chunk);
      this.trailing = this.tags;
      this.tags = [];
      this.spoken = '';
      this.candidates = [];
      this.forced = [];
    }
    return out;
  }

  /**
   * The earliest confirmed sentence end, as an index one past the last character that
   * belongs to it, or null while nothing is certain.
   */
  private findBoundary(final: boolean): number | null {
    const forced = this.forced.length > 0 ? (this.forced[0] ?? null) : null;
    while (this.candidates.length > 0) {
      if (forced !== null && (this.candidates[0] ?? 0) >= forced) break;
      const at = this.candidates[0] ?? 0;
      if (!this.isSentenceEnd(at)) {
        this.candidates.shift();
        continue;
      }
      let j = at;
      let selfSpacing = false;
      while (terminators.has(this.spoken.charAt(j))) {
        if (selfSpacingTerminators.has(this.spoken.charAt(j))) selfSpacing = true;
        j += 1;
      }
      while (CLOSERS.has(this.spoken.charAt(j))) j += 1;
      if (selfSpacing) return j;
      if (j >= this.spoken.length) {
        // Nothing follows yet. At the end of the stream that is an ending; before it,
        // the next token decides, and no later candidate may be taken ahead of this one.
        return final ? j : null;
      }
      if (!isWhitespace(this.spoken.charAt(j))) {
        // `3.14`, `example.com`, `U.S.A` — a terminator with text hard against it.
        this.candidates.shift();
        continue;
      }
      return j;
    }
    return forced;
  }

  /** Whether the terminator at `at` ends a sentence rather than an abbreviation. */
  private isSentenceEnd(at: number): boolean {
    if (this.spoken.charAt(at) !== '.') return true;
    let k = at - 1;
    let word = '';
    while (k >= 0 && isLetter(this.spoken.charAt(k))) {
      word = this.spoken.charAt(k) + word;
      k -= 1;
    }
    if (word.length === 1) return false; // an initial: `J. R. R.`, `e.g.`, `U.S.`
    if (word.length > 1 && ABBREVIATIONS.has(word.toLowerCase())) return false;
    if (word.length === 0 && at > 0 && isDigit(this.spoken.charAt(at - 1))) {
      // Digits before a period are a list marker (`1. First`) only when the run starts a
      // line. Inside a number the same shape is the end of a sentence: `Pi is 3.14.`
      let d = at - 1;
      while (d >= 0 && isDigit(this.spoken.charAt(d))) d -= 1;
      const before = d < 0 ? '' : this.spoken.charAt(d);
      return before === '.' || isDigit(before);
    }
    return true;
  }

  /** Break a sentence that has outgrown `maxChars`: clause mark, else space, else limit. */
  private forceCut(): number {
    const limit = Math.min(this.maxChars, this.spoken.length);
    for (let k = limit - 1; k > 0; k -= 1) {
      if (CLAUSE_MARKS.has(this.spoken.charAt(k)) && isWhitespace(this.spoken.charAt(k + 1))) {
        return k + 1;
      }
    }
    for (let k = limit - 1; k > 0; k -= 1) {
      if (isWhitespace(this.spoken.charAt(k))) return k;
    }
    let cut = limit;
    if (cut < this.spoken.length && isLowSurrogate(this.spoken.charAt(cut))) cut -= 1;
    return cut;
  }

  /**
   * Cut `spoken` at `cut`, returning the chunk, or null when there was nothing to say —
   * in which case the pending tags stay pending and ride out on the next chunk.
   */
  private take(cut: number): SpeechChunk | null {
    const text = this.spoken.slice(0, cut).trimEnd();
    const rest = this.spoken.slice(cut).replace(/^\s+/, '');
    const shift = this.spoken.length - rest.length;

    if (text.length === 0) {
      this.spoken = rest;
      // -1 keeps every tag: there is no chunk here for one to be attached to.
      this.shiftPending(shift, -1);
      return null;
    }

    const tags = this.tags.filter((tag) => tag.offset <= text.length);
    this.spoken = rest;
    this.shiftPending(shift, text.length);
    return { index: this.nextIndex++, text, tags };
  }

  /** Rebase everything still pending onto the new start of `spoken`. */
  private shiftPending(shift: number, keptThrough: number): void {
    this.tags = this.tags
      .filter((tag) => tag.offset > keptThrough)
      .map((tag) => ({ ...tag, offset: Math.max(0, tag.offset - shift) }));
    this.candidates = this.candidates
      .filter((at) => at >= shift)
      .map((at) => at - shift);
    this.forced = this.forced.filter((at) => at > shift).map((at) => at - shift);
  }
}

/** Chunk a complete string in one call. The streaming path with a single push. */
export function chunkText(text: string, options: SentenceChunkerOptions = {}): SpeechChunk[] {
  const chunker = new SentenceChunker(options);
  return [...chunker.push(text), ...chunker.flush()];
}
