import { describe, expect, it } from 'vitest';
import { kokoroWordTimings } from './word-timings';

/**
 * The phoneme strings are the timestamped export's own, printed by the P2-T09 probe
 * (kokoro-js 1.2.1, af_heart). The durations are made up so the arithmetic is readable:
 * 10 frames per pad, 1 per space, 2 per any other character — 25 ms a frame at 24 kHz.
 */
const RATE = 24_000;

function durationsFor(phonemes: string): number[] {
  return [10, ...[...phonemes].map((char) => (char === ' ' ? 1 : 2)), 10];
}

function timings(text: string, phonemes: string) {
  const durations = durationsFor(phonemes);
  const frames = durations.reduce((sum, d) => sum + d, 0);
  return kokoroWordTimings(text, phonemes, durations, frames * 600, RATE);
}

/**
 * Where a group starts in the made-up durations, by hexgrad's `join_timestamps` rule: the
 * pad less 3 frames, everything before the group's first character, less half the space in
 * front of it.
 */
function groupStartMs(phonemes: string, group: number): number {
  const chars = [...phonemes];
  let frames = 10 - 3;
  let seen = 0;
  for (const [index, char] of chars.entries()) {
    if (seen === group && char !== ' ') return Math.round((frames - (index > 0 ? 0.5 : 0)) * 25);
    if (char === ' ') seen += 1;
    frames += char === ' ' ? 1 : 2;
  }
  throw new Error(`no group ${group}`);
}

describe('kokoroWordTimings', () => {
  it('times each word from the start of its own group when they pair one to one', () => {
    const phonemes = 'ɪɾ ɪz lˈʌvli tə sˈiː juː ɐɡˈɛn.';
    const words = timings('It is lovely to see you again.', phonemes);
    expect(words?.map((word) => word.text)).toEqual(['It', 'is', 'lovely', 'to', 'see', 'you', 'again.']);
    expect(words?.map((word) => word.startMs)).toEqual([0, 1, 2, 3, 4, 5, 6].map((group) => groupStartMs(phonemes, group)));
  });

  it('starts a word on its stress mark, which the model gives frames of its own', () => {
    // Pad 10 frames less hexgrad's 3: both start at frame 7, stress mark or not.
    expect(timings('lovely', 'lˈʌvli')?.[0]?.startMs).toBe(175);
    expect(timings('again', 'ˈɐɡɛn')?.[0]?.startMs).toBe(175);
  });

  it('shares a group espeak merged ("in the" is ɪnðɪ) between its words by length', () => {
    const phonemes = 'ænd ɪt kˈɔːt ðə dˈʌst ɪnðɪ ˈɛɹ.';
    const words = timings('and it caught the dust in the air.', phonemes);
    expect(words).toHaveLength(8);
    const [inWord, theWord, air] = [words?.[5], words?.[6], words?.[7]];
    expect(inWord?.startMs).toBe(groupStartMs(phonemes, 5));
    // "in" is 2 letters of 5, so "the" starts two fifths of the way through the group.
    expect(theWord?.startMs).toBeGreaterThan(inWord?.startMs ?? 0);
    expect(theWord?.startMs).toBeLessThan(air?.startMs ?? 0);
    expect(air?.startMs).toBe(groupStartMs(phonemes, 6));
  });

  it('gives a number every group it was read out as, and keeps the dash as its own word', () => {
    const phonemes = 'aɪ hæv twˈɛnti fˈaɪv ˈæpəlz — ˈɑːnɪstli.';
    const words = timings('I have 25 apples — honestly.', phonemes);
    expect(words?.map((word) => word.text)).toEqual(['I', 'have', '25', 'apples', '—', 'honestly.']);
    expect(words?.[2]?.startMs).toBe(groupStartMs(phonemes, 2));
    expect(words?.[3]?.startMs).toBe(groupStartMs(phonemes, 4));
    expect(words?.[5]?.startMs).toBe(groupStartMs(phonemes, 6));
  });

  it('follows an amount spoken as five groups and an initialism spoken as one', () => {
    const phonemes = 'ðæt ɪz ðə jˈuːˈɛs vˈɜːʒən, ɐbˌaʊt fˈoːɹ dˈɑːlɚz ænd fˈɪfti sˈɛnts ˈiːtʃ.';
    const words = timings('that is the U.S. version, about $4.50 each.', phonemes);
    expect(words?.map((word) => word.startMs)).toEqual([0, 1, 2, 3, 4, 5, 6, 11].map((group) => groupStartMs(phonemes, group)));
  });

  it('keeps words in order, each inside the audio', () => {
    const phonemes = 'wˈɛl, ɪts θɹˈiː θˈɜːɾi pˈiːˈɛm., ænd dˈɑːktɚ smˈɪθ ˌɪzənt hˈɪɹ.';
    const words = timings("Well, it's 3:30 p.m., and Dr. Smith isn't here.", phonemes) ?? [];
    expect(words).toHaveLength(9);
    const totalMs = (durationsFor(phonemes).reduce((sum, d) => sum + d, 0) * 1000 * 600) / RATE;
    for (const [index, word] of words.entries()) {
      expect(word.endMs).toBeGreaterThanOrEqual(word.startMs);
      expect(word.endMs).toBeLessThanOrEqual(totalMs);
      if (index > 0) expect(word.startMs).toBeGreaterThanOrEqual(words[index - 1]?.startMs ?? 0);
    }
    expect(words[6]?.startMs).toBe(groupStartMs(phonemes, 7)); // "Smith"
  });

  it('rounds each duration, as the model does before it makes the audio', () => {
    // The probe's first sentence: these floats round to 62 frames, and the waveform was 37,200 samples.
    const durations = [17.75, 3.02, 2.16, 1.92, 1.05, 1.94, 1.99, 2.02, 2.0, 3.04, 3.3, 14.03, 7.36, 1.0];
    const words = kokoroWordTimings('Oh, hello!', 'ˈoʊ, həlˈoʊ!', durations, 37_200, RATE);
    // "Oh" at the pad (18) less 3. "hello!" after ˈoʊ, (3+2+2+1) and half the 2-frame
    // space, less 3: 18+8+1-3 = 24 — which is also where "Oh," ends, the space shared.
    expect(words?.map((word) => word.startMs)).toEqual([15 * 25, 24 * 25]);
    // "hello!" ends at the closing pad (61 frames in), less 3.
    expect(words?.map((word) => word.endMs)).toEqual([24 * 25, 58 * 25]);
  });

  it('gives up rather than guessing when the durations do not fit the phonemes', () => {
    expect(kokoroWordTimings('Hello.', 'həlˈoʊ.', [1, 2, 3], 1800, RATE)).toBeNull();
  });
});
