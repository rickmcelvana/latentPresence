import { AffectReadingSchema } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { LABELLED_USER_MESSAGES, type LabelledMessage } from './fixtures/user-text.labelled';
import { chunkText } from '../chunker';
import { MessagePace, NO_CUE_CONFIDENCE, TAG_CONFIDENCE, readUserText, readingFromTag } from './user-text';

type Labelled = LabelledMessage;
const LABELLED = LABELLED_USER_MESSAGES;
const read = LABELLED.map((message) => ({ message, reading: readUserText(message.text) }));
const of = (cue: Labelled['cue']) => read.filter(({ message }) => message.cue === cue);
const polarity = (valence: number): Labelled['valence'] => (valence > 0.15 ? 'pos' : valence < -0.15 ? 'neg' : 'neu');
const share = (hits: number, total: number) => hits / total;

/**
 * P3-T04's done-when: *"unit tests over a labelled set of 100 messages reach agreed
 * thresholds"*. The set (`fixtures/user-text.labelled.ts`) was written by a separate agent
 * that never saw the scorer, labelled by what a reader perceives, and split by where the
 * feeling shows: `surface` (emoji, punctuation, capitals, words that name it), `semantic`
 * (only the situation says it — the model's `[user:x]` is for those) and `none`.
 *
 * **Thresholds (proposed 2026-09-24, flagged for Rick):** measured blind, before any tuning,
 * the scorer got 38 of 45 surface messages; seven rules later, 44. Because the set was then
 * used to tune, the blind figure is the honest estimate for new text, and the bar sits under it.
 */
describe('readUserText — the labelled set (P3-T04)', () => {
  it('has the shape it was asked for', () => {
    expect(LABELLED).toHaveLength(100);
    expect(of('surface').length + of('semantic').length + of('none').length).toBe(100);
  });

  it('names the feeling on at least 80% of surface-cued messages (blind: 84%, tuned: 98%)', () => {
    const right = of('surface').filter(({ message, reading }) => reading.label === message.label).length;
    expect(share(right, of('surface').length)).toBeGreaterThanOrEqual(0.8);
  });

  it('leaves at least 90% of neutral messages without a confident feeling', () => {
    const calm = of('none').filter(({ reading }) => reading.label === 'neutral' || reading.confidence < 0.3).length;
    expect(share(calm, of('none').length)).toBeGreaterThanOrEqual(0.9);
  });

  it('abstains on at least 90% of messages only the situation explains — that is the model\'s job', () => {
    const abstained = of('semantic').filter(({ reading }) => reading.label === 'neutral' || reading.confidence < 0.5).length;
    expect(share(abstained, of('semantic').length)).toBeGreaterThanOrEqual(0.9);
  });

  it('never states the opposite of how the user feels with confidence', () => {
    // The one failure that would make her react wrongly rather than not at all.
    const contradicted = read.filter(
      ({ message, reading }) =>
        reading.confidence >= 0.5 && message.valence !== 'neu' && polarity(reading.valence) !== 'neu' && polarity(reading.valence) !== message.valence,
    );
    expect(contradicted.map(({ message }) => message.text)).toEqual([]);
  });

  it('always produces a valid text reading', () => {
    for (const { reading } of read) {
      expect(AffectReadingSchema.safeParse(reading).success).toBe(true);
      expect(reading.channel).toBe('text');
    }
  });
});

describe('readUserText — the cues, one at a time', () => {
  it('reads nothing into nothing', () => {
    expect(readUserText('can you set a timer for ten minutes')).toMatchObject({ label: 'neutral', confidence: NO_CUE_CONFIDENCE, cues: [] });
  });

  it('reads emoji and emoticons on their own', () => {
    // The labelled set carries few emoji-only feelings, so it would not notice these going.
    expect(readUserText('😭😭').label).toBe('sad');
    expect(readUserText('🎉🎉🎉').label).toBe('happy');
    expect(readUserText('🤮').label).toBe('disgusted');
    expect(readUserText('😱').label).toBe('fearful');
    expect(readUserText('ok :(').label).toBe('sad');
    expect(readUserText('see you then :D').label).toBe('happy');
    expect(readUserText('👍').label).toBe('neutral');
  });

  it('turns a negated feeling round', () => {
    expect(readUserText('not bad at all').label).not.toBe('sad');
    expect(readUserText("i'm not happy about this").label).toBe('sad');
  });

  it('reads sarcasm as complaint, not joy', () => {
    expect(readUserText('oh great, another monday').label).toBe('angry');
  });

  it('lets laughter lift a message, unless something darker is there', () => {
    expect(readUserText('haha that is brilliant').label).toBe('happy');
    expect(readUserText("i'm crying rn lol").label).toBe('sad');
  });

  it('hears shouting as intensity on the feeling that is there, and as anger when none is', () => {
    const calm = readUserText('i got the job!');
    const loud = readUserText('I GOT THE JOB AMAZING');
    expect(loud.label).toBe('happy');
    expect(loud.arousal).toBeGreaterThan(calm.arousal);
    expect(readUserText('STOP DOING THAT').label).toBe('angry');
  });

  it('raises arousal for a quick burst of messages', () => {
    const pace = new MessagePace();
    pace.observe(0);
    pace.observe(1500);
    const burst = pace.observe(2500);
    expect(burst).toEqual({ gapMs: 1000, burst: 3 });
    expect(readUserText('why is this happening', burst).arousal).toBeGreaterThan(readUserText('why is this happening').arousal);
    expect(pace.observe(60_000)).toEqual({ gapMs: 57_500, burst: 1 });
  });
});

describe('readingFromTag — the model\'s own read (ADR-32)', () => {
  it('turns [user:x] into a text reading at a fixed confidence', () => {
    const [chunk] = chunkText('[user:fearful] [emote:concern] That sounds frightening.');
    const tag = chunk?.tags.find((candidate) => candidate.kind === 'user');
    if (tag === undefined) throw new Error('no user tag');
    expect(readingFromTag(tag)).toEqual({ channel: 'text', label: 'fearful', valence: -0.6, arousal: 0.6, confidence: TAG_CONFIDENCE });
  });

  it('ignores every other tag and a label the model invented', () => {
    const [chunk] = chunkText('[user:weepy] [emote:concern] Oh.');
    for (const tag of chunk?.tags ?? []) expect(readingFromTag(tag)).toBeNull();
  });
});
