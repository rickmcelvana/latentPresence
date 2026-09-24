import { describe, expect, it } from 'vitest';
import {
  CharacterEmotionSchema,
  CharacterGestureSchema,
  type ConversationEvent,
  type InlineTag,
  type SentenceTiming,
} from '@latentpresence/protocol';
import { EMOTION_EXPRESSIONS } from '../mappings/emotions';
import { GESTURE_MOTIONS } from '../mappings/gestures';
import { RELEASE_AFTER_MS, TagBridge, type FiredCue } from './bridge';
import { CuePerformer } from './performer';
import { scheduleCues } from './schedule';

const tag = (kind: 'emote' | 'gesture', value: string, offset: number): InlineTag => ({
  kind,
  value,
  known: value as InlineTag['known'],
  offset,
});

describe('scheduleCues', () => {
  const text = 'Oh hello there, it is good to see you.';
  const timing: SentenceTiming = { durationMs: 2400, voicedStartMs: 50, voicedEndMs: 2150 };

  it('interpolates by character across the voiced span, at the start of the tagged word', () => {
    // "there" starts at character 9 of 38: 50 + 2100 × 9/38.
    const [cue] = scheduleCues(text, [tag('gesture', 'nod', 9)], timing);
    expect(cue?.atMs).toBe(Math.round(50 + (2100 * 9) / 38));
  });

  it('gives a tag written just before a word to that word, and one at the very start to the voice onset', () => {
    // A tag lifted from "[gesture:nod] there" sits at the space before "there".
    expect(scheduleCues(text, [tag('gesture', 'nod', 8)], timing)[0]?.atMs).toBe(scheduleCues(text, [tag('gesture', 'nod', 9)], timing)[0]?.atMs);
    expect(scheduleCues(text, [tag('emote', 'joy', 0)], timing)[0]?.atMs).toBe(50);
  });

  it('puts a tag after the last word at the end of the voice, not in the padding', () => {
    expect(scheduleCues(text, [tag('emote', 'joy', text.length)], timing)[0]?.atMs).toBe(2150);
  });

  it('uses the backend word timings when there is one per word', () => {
    const words = text.split(' ').map((word, index) => ({ text: word, startMs: 100 + index * 200, endMs: 280 + index * 200 }));
    // "there" is the third word.
    expect(scheduleCues(text, [tag('gesture', 'nod', 9)], { ...timing, words })[0]?.atMs).toBe(500);
  });
});

describe('the mappings', () => {
  it('cover every emotion and every gesture the protocol has', () => {
    for (const emotion of CharacterEmotionSchema.options) expect(EMOTION_EXPRESSIONS[emotion]).toBeDefined();
    for (const gesture of CharacterGestureSchema.options) expect(GESTURE_MOTIONS[gesture]).not.toBeUndefined();
  });

  it('gesture motions start and end at rest, so none of them pops', () => {
    for (const [name, motion] of Object.entries(GESTURE_MOTIONS)) {
      if (motion === null) continue;
      for (const t of [0, motion.durationMs]) {
        for (const rotation of Object.values(motion.pose(t))) {
          for (const value of rotation) expect(Math.abs(value), `${name} at ${t} ms`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('gesture motions stay within a natural head speed, ~200°/s, between 60 fps frames', () => {
    // Not the life layer's 0.02 rad a frame: that bounds idle drift, and a head shake is a
    // deliberate movement people make at 200°/s and more. Pops are the test above's job;
    // this one catches a motion so fast it would read as a glitch.
    for (const [name, motion] of Object.entries(GESTURE_MOTIONS)) {
      if (motion === null) continue;
      let previous = motion.pose(0);
      for (let t = 16; t <= motion.durationMs; t += 16) {
        const pose = motion.pose(t);
        for (const [bone, rotation] of Object.entries(pose)) {
          const before = (previous as Record<string, readonly number[]>)[bone] ?? [0, 0, 0];
          rotation.forEach((value, axis) => expect(Math.abs(value - (before[axis] ?? 0)), `${name} ${bone} at ${t}`).toBeLessThan(0.06));
        }
        previous = pose;
      }
    }
  });
});

describe('CuePerformer', () => {
  it('eases the face to an emote and back to neutral on release', () => {
    const performer = new CuePerformer();
    expect(performer.perform(tag('emote', 'joy', 0))).toBe('performed');
    let frame = performer.update(16);
    expect(frame.expression.happy ?? 0).toBeGreaterThan(0);
    expect(frame.expression.happy ?? 0).toBeLessThan(0.7);
    for (let i = 0; i < 60; i += 1) frame = performer.update(16);
    expect(frame.expression.happy ?? 0).toBeCloseTo(0.7, 2);
    performer.release();
    for (let i = 0; i < 200; i += 1) frame = performer.update(16);
    expect(frame.expression.happy).toBeUndefined();
  });

  it('runs a gesture once and adds overlapping ones together', () => {
    const performer = new CuePerformer();
    performer.perform(tag('gesture', 'nod', 0));
    performer.perform(tag('gesture', 'tilt-head', 0));
    const frame = performer.update(190);
    expect(frame.additive.head?.[0] ?? 0).toBeGreaterThan(0.1);
    expect(frame.additive.head?.[2] ?? 0).toBeGreaterThan(0);
    let last = frame;
    for (let i = 0; i < 200; i += 1) last = performer.update(16);
    expect(last.additive).toEqual({});
  });

  it('reports what it cannot do rather than doing something else', () => {
    const performer = new CuePerformer();
    expect(performer.perform(tag('gesture', 'wave', 0))).toBe('unmapped');
    expect(performer.perform({ kind: 'emote', value: 'smug', known: null, offset: 0 })).toBe('unmapped');
    // P3-T04: the model's read of the user is not something she does.
    expect(performer.perform({ kind: 'user', value: 'sad', known: 'sad', offset: 0 })).toBe('unmapped');
    expect(performer.update(16).expression).toEqual({});
  });
});

function wordsOf(text: string, startMs: number, msPerWord: number) {
  return text.split(' ').map((word, index) => ({ text: word, startMs: startMs + index * msPerWord, endMs: startMs + (index + 1) * msPerWord - 20 }));
}

describe('TagBridge', () => {
  const at = '2026-09-23T00:00:00.000Z';
  const sentence = (index: number, text: string, tags: InlineTag[]): ConversationEvent => ({
    type: 'assistant.sentence',
    sessionId: 's',
    at,
    index,
    text,
    tags,
  });
  const started = (sentenceIndex: number, timing: SentenceTiming): ConversationEvent => ({
    type: 'assistant.audio.started',
    sessionId: 's',
    at,
    sentenceIndex,
    timing,
  });

  it('P2-T07 done-when: a scripted response with five tags fires each within 100 ms of its word', () => {
    // Two sentences, five tags, and the words' true starts as a backend would report them.
    const first = 'Oh, hello! It is lovely to see you again.';
    const second = 'Honestly, I was not sure you would come back today.';
    const firstWords = wordsOf(first, 60, 230);
    const secondWords = wordsOf(second, 55, 210);
    const tags1 = [tag('emote', 'joy', 0), tag('gesture', 'nod', first.indexOf('hello')), tag('gesture', 'tilt-head', first.indexOf('lovely'))];
    const tags2 = [tag('emote', 'concern', second.indexOf('I was')), tag('gesture', 'shake-head', second.indexOf('not'))];

    const fired: FiredCue[] = [];
    const bridge = new TagBridge(new CuePerformer(), { onFire: (cue) => fired.push(cue) });
    bridge.handle(sentence(0, first, tags1), 0);
    bridge.handle(sentence(1, second, tags2), 5);
    bridge.handle(started(0, { durationMs: 2600, voicedStartMs: 60, voicedEndMs: 2330, words: firstWords }), 1000);
    bridge.handle(started(1, { durationMs: 2600, voicedStartMs: 55, voicedEndMs: 2150, words: secondWords }), 3700);
    // A 60 fps frame loop.
    for (let now = 1000; now < 7000; now += 1000 / 60) bridge.update(now);

    const truth = [
      1000 + (firstWords[0]?.startMs ?? 0),
      1000 + (firstWords[1]?.startMs ?? 0),
      1000 + (firstWords[4]?.startMs ?? 0),
      3700 + (secondWords[1]?.startMs ?? 0),
      3700 + (secondWords[3]?.startMs ?? 0),
    ];
    expect(fired.map((cue) => cue.tag.value)).toEqual(['joy', 'nod', 'tilt-head', 'concern', 'shake-head']);
    fired.forEach((cue, index) => expect(Math.abs(cue.firedAt - (truth[index] ?? 0))).toBeLessThan(100));
  });

  it('fires nothing for a sentence that was never heard, and lets the face go on a barge-in', () => {
    const fired: FiredCue[] = [];
    const performer = new CuePerformer();
    const bridge = new TagBridge(performer, { onFire: (cue) => fired.push(cue) });
    bridge.handle(sentence(0, 'Well, let me think about that.', [tag('emote', 'curiosity', 0), tag('gesture', 'think', 6)]), 0);
    bridge.handle(started(0, { durationMs: 2000, voicedStartMs: 50, voicedEndMs: 1800 }), 100);
    bridge.update(200);
    expect(fired.map((cue) => cue.tag.value)).toEqual(['curiosity']);
    bridge.handle({ type: 'assistant.interrupted', sessionId: 's', at, spokenPrefix: 'Well,' }, 250);
    for (let now = 250; now < 3000; now += 16) bridge.update(now);
    expect(fired.map((cue) => cue.tag.value)).toEqual(['curiosity']);
    let frame = performer.update(16);
    for (let i = 0; i < 200; i += 1) frame = performer.update(16);
    expect(frame.expression).toEqual({});
  });

  it('holds the last emote after the answer, then lets go', () => {
    const performer = new CuePerformer();
    const bridge = new TagBridge(performer);
    bridge.handle(sentence(0, 'That is wonderful news.', [tag('emote', 'joy', 0)]), 0);
    bridge.handle(started(0, { durationMs: 1500, voicedStartMs: 50, voicedEndMs: 1300 }), 0);
    bridge.update(60);
    bridge.handle({ type: 'assistant.message', sessionId: 's', at, entry: { id: 'e', role: 'assistant', text: 'x', at } } as ConversationEvent, 1500);
    bridge.update(1500 + RELEASE_AFTER_MS - 10);
    for (let i = 0; i < 60; i += 1) performer.update(16);
    expect(performer.update(16).expression.happy ?? 0).toBeGreaterThan(0.6);
    bridge.update(1500 + RELEASE_AFTER_MS + 10);
    for (let i = 0; i < 200; i += 1) performer.update(16);
    expect(performer.update(16).expression).toEqual({});
  });
});
