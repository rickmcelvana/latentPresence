import { describe, expect, it } from 'vitest';
import { heardText, spokenPrefix, voicedRange, type SpokenSentence } from './prefix';

const RATE = 24_000;

/** "one two three four" is 18 characters; over 18 000 frames each character is 1000 frames. */
const plain: SpokenSentence = { text: 'one two three four', frames: 18_000, sampleRate: RATE };

describe('voicedRange', () => {
  it('trims silence at both ends and keeps what is between', () => {
    const samples = new Float32Array([0, 0.001, 0.5, 0, -0.4, 0.003, 0]);
    expect(voicedRange(samples)).toEqual({ start: 2, end: 5 });
  });

  it('treats an all-silent sentence as voiced throughout rather than empty', () => {
    expect(voicedRange(new Float32Array(8))).toEqual({ start: 0, end: 8 });
  });
});

describe('heardText', () => {
  it('counts a word only once its estimated end has been rendered', () => {
    // "one" ends at character 3 → frame 3000.
    expect(heardText(plain, 2999)).toBe('');
    expect(heardText(plain, 3000)).toBe('one');
    // "two" ends at character 7 → frame 7000; half of it is not a word heard.
    expect(heardText(plain, 6999)).toBe('one');
    expect(heardText(plain, 7000)).toBe('one two');
  });

  it('returns the whole sentence once every frame has played, and nothing before the first', () => {
    expect(heardText(plain, 18_000)).toBe('one two three four');
    expect(heardText(plain, 0)).toBe('');
  });

  it('spreads the words across the voiced range, not across the padding', () => {
    // Speech over [6000, 12000): 333 frames a character, so "one" ends at 6000 + 3 × 333 = 7000.
    const padded: SpokenSentence = { ...plain, voicedStart: 6000, voicedEnd: 12_000 };
    expect(heardText(padded, 5999)).toBe('');
    expect(heardText(padded, 7000)).toBe('one');
    // Without the range the same frame would claim two words.
    expect(heardText(plain, 7000)).toBe('one two');
  });

  it('keeps punctuation attached to the word it belongs to', () => {
    const sentence: SpokenSentence = { text: 'Well, no.', frames: 9000, sampleRate: RATE };
    expect(heardText(sentence, 5000)).toBe('Well,');
  });

  it('prefers backend word timings when they match the words', () => {
    const timed: SpokenSentence = {
      ...plain,
      words: [
        { text: 'one', startMs: 0, endMs: 100 },
        { text: 'two', startMs: 100, endMs: 600 },
        { text: 'three', startMs: 600, endMs: 700 },
        { text: 'four', startMs: 700, endMs: 750 },
      ],
    };
    // 0.5 s = 12 000 frames: proportionally that is two words, by the timings only one.
    expect(heardText(plain, 12_000)).toBe('one two');
    expect(heardText(timed, 12_000)).toBe('one');
  });

  it('falls back to the estimate when the timings do not line up with the text', () => {
    const mismatched: SpokenSentence = { ...plain, words: [{ text: 'one', startMs: 0, endMs: 10 }] };
    expect(heardText(mismatched, 7000)).toBe('one two');
  });
});

describe('spokenPrefix', () => {
  const first: SpokenSentence = { text: 'Hello there.', frames: 12_000, sampleRate: RATE };
  const second: SpokenSentence = { text: 'How are you today?', frames: 18_000, sampleRate: RATE };

  it('is empty when nothing played', () => {
    expect(spokenPrefix([first, second], null)).toBe('');
  });

  it('keeps earlier sentences whole and the current one to the heard word', () => {
    expect(spokenPrefix([first, second], { index: 1, frame: 7000 })).toBe('Hello there. How are');
  });

  it('runs a frame past a sentence end on into the next sentence', () => {
    // 12 000 + 4000: the fade's second half lands 4000 frames into "How are you today?".
    expect(spokenPrefix([first, second], { index: 0, frame: 16_000 })).toBe('Hello there. How');
  });

  it('converts the overflow between sentences at different rates', () => {
    const slow: SpokenSentence = { text: 'How are you today?', frames: 9000, sampleRate: 12_000 };
    // 4000 frames at 24 kHz is 2000 at 12 kHz: "How" ends at character 3 of 18 → 1500.
    expect(spokenPrefix([first, slow], { index: 0, frame: 16_000 })).toBe('Hello there. How');
  });

  it('stops at the last sentence it was given, however far the frame runs', () => {
    expect(spokenPrefix([first], { index: 0, frame: 99_000 })).toBe('Hello there.');
  });
});
