import type { AffectReading, InlineTag, UserEmotion } from '@latentpresence/protocol';

/**
 * User affect from text (P3-T04): the text channel's two readers, both producing the
 * protocol's `AffectReading` for fusion (P3-T07).
 *
 * - **`readUserText`** — a heuristic over what shows on the surface: emoji and emoticons,
 *   laughter, repeated and mixed punctuation, capitals, stretched words, a small lexicon of
 *   words that *name* a feeling, a handful of sarcasm frames, and how fast messages arrive.
 *   Instant and free, so the face can react while the model is still thinking. **It does
 *   not understand situations** — "my dog died this morning" has no surface cue and gets
 *   `neutral` at low confidence, which is the honest answer for a keyword reader.
 * - **`readingFromTag`** — the model's own read, `[user:x]` at the start of its reply
 *   (ADR-32): slower (it arrives with the answer) but it understands the situation.
 *
 * Every weight is hand-set and explained where it is used; the labelled set in
 * `fixtures/user-text.labelled.ts` was written separately, by someone who had not seen
 * this file, and is what the thresholds are measured on.
 */

/** Where each label sits in valence and arousal, before surface intensity moves it. */
export const USER_EMOTION_VA: Readonly<Record<UserEmotion, { readonly valence: number; readonly arousal: number }>> = {
  neutral: { valence: 0, arousal: 0 },
  happy: { valence: 0.7, arousal: 0.4 },
  sad: { valence: -0.6, arousal: -0.4 },
  angry: { valence: -0.6, arousal: 0.7 },
  fearful: { valence: -0.6, arousal: 0.6 },
  disgusted: { valence: -0.6, arousal: 0.3 },
  surprised: { valence: 0.1, arousal: 0.7 },
  other: { valence: 0, arousal: 0 },
  unknown: { valence: 0, arousal: 0 },
};

type Scored = Exclude<UserEmotion, 'neutral' | 'other' | 'unknown'>;

/** A text reading, with the cues that produced it — for tests and a debug overlay. */
export interface TextReading extends AffectReading {
  readonly cues: readonly string[];
}

/** How messages are arriving, from `MessagePace`. */
export interface PaceSample {
  /** Since the previous message, or null for the first. */
  readonly gapMs: number | null;
  /** Messages in the current run of quick ones, this one included. */
  readonly burst: number;
}

/** Tracks the gaps between the user's messages: a quick run of them reads as agitation. */
export class MessagePace {
  private last: number | null = null;
  private burst = 0;
  /** A message this soon after the last continues a burst. */
  static readonly BURST_GAP_MS = 4000;

  observe(at: number): PaceSample {
    const gapMs = this.last === null ? null : at - this.last;
    this.burst = gapMs !== null && gapMs <= MessagePace.BURST_GAP_MS ? this.burst + 1 : 1;
    this.last = at;
    return { gapMs, burst: this.burst };
  }
}

// ── Surface cues ────────────────────────────────────────────────────────────────────

/** Emoji that carry a feeling, by label. 👍 👌 🙂 carry politeness more than feeling and are absent on purpose. */
const EMOJI: Readonly<Record<Scored, readonly string[]>> = {
  happy: ['😀', '😃', '😄', '😁', '😆', '😊', '☺', '😍', '🥰', '😘', '❤', '💕', '💖', '💗', '💛', '💙', '💜', '🧡', '💚', '🎉', '🥳', '✨', '👏', '🙌', '😂', '🤣', '😹', '😸', '😻', '🤗', '😎', '🤩', '💃', '🕺', '🌞', '😌', '😋'],
  sad: ['😢', '😭', '😞', '😔', '☹', '🙁', '💔', '😿', '🥺', '😪', '😓', '😥'],
  angry: ['😠', '😡', '🤬', '👿', '💢', '🙄', '😤', '😒', '🖕'],
  fearful: ['😨', '😰', '😱', '😟', '😧', '😬', '😖', '🫣', '🥶'],
  disgusted: ['🤢', '🤮', '🤧', '😷'],
  surprised: ['😮', '😯', '😲', '🤯', '😳', '‼', '⁉', '😵'],
};

/** Western emoticons, matched as whole tokens. */
const EMOTICONS: readonly [RegExp, Scored][] = [
  [/(^|\s)(?::|=|;)-?[)\]D]+(?=\s|$)/u, 'happy'],
  [/(^|\s)\^_*\^(?=\s|$)/u, 'happy'],
  [/(^|\s)<3+(?=\s|$)/u, 'happy'],
  [/(^|\s)>:-?\(+(?=\s|$)/u, 'angry'],
  [/(^|\s):'?-?\(+(?=\s|$)/u, 'sad'],
  [/(^|\s)D:(?=\s|$)/u, 'fearful'],
  [/(^|\s):-?[oO0](?=\s|$)/u, 'surprised'],
];

/** Laughter tokens. Happy unless the rest of the message says otherwise (nervous laughter). */
const LAUGHTER = /\b(?:a?ha(?:ha)+h?|he(?:he)+|hihi+|lol+|lmao+|lmfao|rofl|xd+)\b/iu;

/**
 * Words that name a feeling. Deliberately small: a word here should mean the feeling in
 * almost every sentence it appears in. Stems with `\w*` where the endings all agree.
 */
const LEXICON: Readonly<Record<Scored, readonly RegExp[]>> = {
  happy: [
    /\bhapp(?:y|ier|iest)\b/iu, /\bglad\b/iu, /\bawesome\b/iu, /\bamazing\b/iu, /\bwonderful\b/iu, /\bfantastic\b/iu,
    /\bbrilliant\b/iu, /\blove[ds]?\b/iu, /\bloving\b/iu, /\byay+\b/iu, /\bwoo+h?o+\b/iu, /\bexcited\b/iu, /\bthrilled\b/iu,
    /\bdelighted\b/iu, /\bover the moon\b/iu, /\bso good\b/iu, /\bbest day\b/iu, /\bcan'?t wait\b/iu, /\bperfect\b/iu,
    /\bgreat\b/iu, /\blovely\b/iu, /\bproud\b/iu, /\byes+!/iu, /\byess+\b/iu, /\bnailed it\b/iu, /\bwhee+\b/iu,
    /\bmade my day\b/iu, /\bbest\b.{0,20}\bever\b/iu,
  ],
  sad: [
    /\bsad(?:der|dest|ly)?\b/iu, /\bdepress(?:ed|ing)\b/iu, /\blonely\b/iu, /\bheartbroken\b/iu, /\bheart ?break/iu,
    /\bcr(?:y|ying|ied)\b/iu, /\bin tears\b/iu, /\bmiss(?:ing)? (?:him|her|them|you|it)\b/iu, /\bfeel(?:ing)? (?:so )?(?:down|low|empty|awful|terrible)\b/iu,
    /\bgutted\b/iu, /\bdevastated\b/iu, /\bmiserable\b/iu, /\bhopeless\b/iu, /\bunhappy\b/iu, /\bno+o+\b/iu, /\bsigh+\b/iu,
    /\bexhausted\b/iu, /\bso tired\b/iu, /\bwhat'?s the point\b/iu, /\bnot (?:ok(?:ay)?|fine|alright|good)\b/iu,
  ],
  angry: [
    /\bangry\b/iu, /\bfurious\b/iu, /\bmad at\b/iu, /\bso mad\b/iu, /\bpissed\b/iu, /\bhate\b/iu, /\bannoy(?:ed|ing)\b/iu,
    /\bsick (?:and tired )?of\b/iu, /\bfed up\b/iu, /\bridiculous\b/iu, /\bwtf\b/iu, /\bstupid\b/iu,
    /\bworst\b/iu, /\bfuming\b/iu, /\blivid\b/iu, /\bunacceptable\b/iu, /\birritat(?:ed|ing)\b/iu, /\bfrustrat(?:ed|ing)\b/iu,
    /\bdamn\b/iu, /\bf+u+c+k+/iu, /\bshit\b/iu,
  ],
  fearful: [
    /\bscared\b/iu, /\bafraid\b/iu, /\bterrified\b/iu, /\bnervous\b/iu, /\banxious\b/iu, /\banxiety\b/iu, /\bworried\b/iu,
    /\bworrying\b/iu, /\bpanic(?:king|ked)?\b/iu, /\bfreaking out\b/iu, /\bfrightened\b/iu, /\bdread(?:ing)?\b/iu,
    /\bpetrified\b/iu, /\bcan'?t breathe\b/iu, /\bwhat if\b/iu, /\buneasy\b/iu, /\bshaking\b/iu,
  ],
  disgusted: [/\bgross\b/iu, /\bdisgust(?:ed|ing)\b/iu, /\be+w+\b/iu, /\byuck\b/iu, /\bnasty\b/iu, /\brevolting\b/iu, /\bvile\b/iu, /\bsickening\b/iu, /\bick\b/iu, /\bblegh\b/iu],
  surprised: [
    /\bwo+w+\b/iu, /\bwhoa+\b/iu, /\bwoah+\b/iu, /\bomg\b/iu, /\boh my god\b/iu, /\bno way\b/iu, /\bcan'?t believe\b/iu,
    /\bcannot believe\b/iu, /\bunbelievable\b/iu, /\bholy (?:cow|moly|crap|shit)\b/iu, /\bseriously\?!/iu, /\breally\?!/iu,
    /\bwait,? what\b/iu, /\bout of nowhere\b/iu, /\bsurpris(?:ed|ing)\b/iu, /\bshocked\b/iu,
  ],
};

/** A negator within three words before a lexicon hit turns it round. */
const NEGATOR = /\b(?:not|never|no|isn'?t|wasn'?t|aren'?t|don'?t|doesn'?t|didn'?t|can'?t|won'?t|hardly|n'?t)\b/iu;

/**
 * Sarcasm frames: a positive word used to complain. Few, and each one common enough in
 * chat to earn its place; the word inside it then counts for anger, not joy.
 */
const SARCASM: readonly RegExp[] = [
  /\boh,? (?:great|wonderful|perfect|fantastic|brilliant|joy)\b/iu,
  /\bjust (?:great|perfect|wonderful|what i needed)\b/iu,
  /\b(?:great|perfect|wonderful|love it),? (?:another|more|again)\b/iu,
  /\bthanks a lot\b/iu,
  /\byeah,? right\b/iu,
  /\bof course it (?:did|does|is)\b/iu,
];

/** Displeasure words that lean angry but name nothing: `ugh`, a bare `seriously?`. Half a vote. */
const WEAK_ANGRY: readonly [RegExp, string][] = [
  [/\bugh+\b/iu, 'word ugh'],
  [/\bseriously\?(?!!)/iu, 'seriously?'],
];

const LETTERS = /\p{L}/gu;
const UPPER = /\p{Lu}/gu;

function negated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 24), index);
  const words = before.split(/\s+/u).filter(Boolean).slice(-3).join(' ');
  return NEGATOR.test(words);
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/**
 * One message's surface, as a reading. `pace` is optional: without it the message is read
 * alone. A message with no cue is `neutral` at `NO_CUE_CONFIDENCE` — "nothing shows", not
 * "definitely calm".
 */
export function readUserText(text: string, pace?: PaceSample): TextReading {
  const votes: Record<Scored, number> = { happy: 0, sad: 0, angry: 0, fearful: 0, disgusted: 0, surprised: 0 };
  const cues: string[] = [];
  let arousal = 0;
  const vote = (label: Scored, weight: number, cue: string): void => {
    votes[label] += weight;
    cues.push(cue);
  };

  // Emoji: strong, since a person picks one on purpose. Each distinct one counts once.
  for (const [label, list] of Object.entries(EMOJI) as [Scored, readonly string[]][]) {
    for (const emoji of list) {
      if (text.includes(emoji)) vote(label, 1.5, `emoji ${emoji}`);
    }
  }
  for (const [pattern, label] of EMOTICONS) {
    if (pattern.test(text)) vote(label, 1.3, `emoticon ${label}`);
  }

  // Sarcasm first, so the positive word inside it is not also read as joy.
  let sarcastic = false;
  for (const frame of SARCASM) {
    if (frame.test(text)) {
      sarcastic = true;
      vote('angry', 1.4, 'sarcasm');
    }
  }

  for (const [pattern, cue] of WEAK_ANGRY) {
    if (pattern.test(text)) vote('angry', 0.5, cue);
  }

  for (const [label, patterns] of Object.entries(LEXICON) as [Scored, readonly RegExp[]][]) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match === null) continue;
      if (sarcastic && label === 'happy') continue;
      if (negated(text, match.index)) {
        // "not happy" leans low; "not bad", "I don't hate it" lean mildly warm.
        if (label === 'happy') vote('sad', 1, `not ${match[0]}`);
        else vote('happy', 0.4, `not ${match[0]}`);
        continue;
      }
      vote(label, 1, `word ${match[0].toLowerCase()}`);
    }
  }

  // Laughter: joy unless something negative is already stronger (nervous or bitter laughter).
  if (LAUGHTER.test(text)) {
    const negative = votes.sad + votes.angry + votes.fearful + votes.disgusted;
    vote('happy', negative > 0 ? 0.4 : 1.2, 'laughter');
    arousal += 0.15;
  }

  // Punctuation. "?!" is astonishment; a run of "!" is intensity, not a feeling by itself.
  if (/[?][!]|[!][?]/u.test(text)) vote('surprised', 1, '?!');
  const bangs = (text.match(/!/gu) ?? []).length;
  if (bangs >= 2) {
    arousal += Math.min(0.3, 0.1 * bangs);
    cues.push(`${bangs}×!`);
  }
  if (/\.{3,}|…/u.test(text) && !/[!?]/u.test(text)) {
    arousal -= 0.2;
    cues.push('trailing …');
  }

  // Capitals: shouting raises arousal and strengthens whatever else is felt.
  const letters = (text.match(LETTERS) ?? []).length;
  const upper = (text.match(UPPER) ?? []).length;
  const shouting = letters >= 4 && upper / letters >= 0.6;
  if (shouting) {
    arousal += 0.3;
    cues.push('CAPS');
  }

  // Stretched words (sooo, noooo, yessss): intensity.
  const stretched = /(\p{L})\1{2,}/u.test(text);
  if (stretched) {
    arousal += 0.15;
    cues.push('stretched');
  }

  if (pace !== undefined && pace.burst >= 3) {
    arousal += 0.2;
    cues.push(`burst of ${pace.burst}`);
  }

  // Shouting with no feeling on it is anger ("STOP DOING THAT"); shouted joy brings its own
  // cues, which is why this fires only when nothing else has.
  if (shouting && Object.values(votes).every((weight) => weight === 0)) vote('angry', 1, 'CAPS alone');

  const ranked = (Object.entries(votes) as [Scored, number][]).toSorted((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top === undefined || top[1] < MIN_VOTE) {
    return {
      channel: 'text',
      label: 'neutral',
      valence: 0,
      arousal: clamp(arousal, -1, 1),
      confidence: cues.length === 0 ? NO_CUE_CONFIDENCE : WEAK_CUE_CONFIDENCE,
      cues,
    };
  }
  const [label, score] = top;
  // Emphasis only amplifies a feeling that is there.
  const emphasis = (shouting ? 0.4 : 0) + (stretched ? 0.2 : 0) + (bangs >= 2 ? 0.2 : 0);
  const strength = score + emphasis;
  const margin = (score - (second?.[1] ?? 0)) / score;
  const confidence = clamp((1 - Math.exp(-strength / 1.5)) * (0.5 + 0.5 * margin), 0, 0.95);
  const base = USER_EMOTION_VA[label];
  const intensity = clamp(0.6 + 0.2 * strength, 0.6, 1);
  return {
    channel: 'text',
    label,
    valence: clamp(base.valence * intensity, -1, 1),
    arousal: clamp(base.arousal * intensity + arousal, -1, 1),
    confidence,
    cues,
  };
}

/** A vote below this is noise, not a feeling. One lexicon word is exactly enough. */
const MIN_VOTE = 1;
/** What `neutral` is worth with nothing on the surface at all. */
export const NO_CUE_CONFIDENCE = 0.2;
/** And with some intensity but no feeling to attach it to. */
export const WEAK_CUE_CONFIDENCE = 0.15;

/**
 * The model's `[user:x]` as a reading (ADR-32). Its confidence is fixed: a model states a
 * label, not how sure it is, and one it invents (`known: null`) says nothing.
 */
export function readingFromTag(tag: InlineTag, confidence = TAG_CONFIDENCE): AffectReading | null {
  if (tag.kind !== 'user' || tag.known === null) return null;
  const label = tag.known as UserEmotion;
  const va = USER_EMOTION_VA[label];
  return { channel: 'text', label, valence: va.valence, arousal: va.arousal, confidence };
}

/** Until P3-T07 measures fusion, the model's read counts for a little more than a strong surface cue. */
export const TAG_CONFIDENCE = 0.7;
