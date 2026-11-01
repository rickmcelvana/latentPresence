import { describe, expect, it } from 'vitest';
import type { ConversationEvent } from '@latentpresence/protocol';
import { CAPTION_HOLD_MS, emptyCaptions, reduceCaptions, visibleCaption, type CaptionState } from './captions';

const T0 = 1_700_000_000_000;

function base(ms: number): { sessionId: string; at: string } {
  return { sessionId: 's1', at: new Date(T0 + ms).toISOString() };
}

function fold(events: readonly ConversationEvent[], from: CaptionState = emptyCaptions()): CaptionState {
  return events.reduce(reduceCaptions, from);
}

function sentence(ms: number, index: number, text: string): ConversationEvent {
  return { ...base(ms), type: 'assistant.sentence', index, text, tags: [] };
}

function started(ms: number, index: number): ConversationEvent {
  return { ...base(ms), type: 'assistant.audio.started', sentenceIndex: index };
}

function ended(ms: number, index: number): ConversationEvent {
  return { ...base(ms), type: 'assistant.audio.ended', sentenceIndex: index };
}

describe('reduceCaptions (P9-T01, ADR-67)', () => {
  it('shows a sentence when its audio starts, not when it is written', () => {
    const written = fold([sentence(0, 0, 'Hello there.'), sentence(10, 1, 'How are you?')]);
    expect(written.caption).toBeNull();
    const first = reduceCaptions(written, started(100, 0));
    expect(first.caption).toEqual({ speaker: 'her', text: 'Hello there.', sentenceIndex: 0, endedAt: null });
    const second = fold([ended(900, 0), started(950, 1)], first);
    expect(second.caption?.text).toBe('How are you?');
    expect(second.pending.size).toBe(0);
  });

  it('holds a caption for CAPTION_HOLD_MS after its audio ends, then hides it', () => {
    const state = fold([sentence(0, 0, 'Hello.'), started(100, 0), ended(800, 0)]);
    expect(state.caption?.endedAt).toBe(T0 + 800);
    expect(visibleCaption(state, T0 + 800 + CAPTION_HOLD_MS - 1)?.text).toBe('Hello.');
    expect(visibleCaption(state, T0 + 800 + CAPTION_HOLD_MS)).toBeNull();
  });

  it('keeps a caption with no end showing however long it lasts', () => {
    const state = fold([sentence(0, 0, 'A long one.'), started(100, 0)]);
    expect(visibleCaption(state, T0 + 60_000)?.text).toBe('A long one.');
  });

  it("ignores another sentence's end, and an audio start with no sentence written", () => {
    const state = fold([sentence(0, 0, 'One.'), sentence(5, 1, 'Two.'), started(100, 1)]);
    expect(reduceCaptions(state, ended(200, 0))).toBe(state);
    expect(reduceCaptions(state, started(300, 7))).toBe(state);
  });

  it('a barge-in clears her caption and everything not yet said', () => {
    const state = fold([sentence(0, 0, 'One.'), sentence(5, 1, 'Two.'), started(100, 0)]);
    const cut = reduceCaptions(state, { ...base(200), type: 'assistant.interrupted', spokenPrefix: 'On' });
    expect(cut.caption).toBeNull();
    expect(reduceCaptions(cut, started(300, 1)).caption).toBeNull();
  });

  it('a typed reply nobody hears has no caption, and a settled answer forgets its unplayed sentences', () => {
    const typed = fold([sentence(0, 0, 'Written, not said.')]);
    expect(typed.caption).toBeNull();
    const settled = reduceCaptions(typed, { ...base(50), type: 'assistant.message', entry: { id: 'a1', role: 'assistant', text: 'Written, not said.', at: base(50).at, spokenPrefix: null } });
    expect(settled.pending.size).toBe(0);
    // The next answer's sentence 0 is its own, not the old one.
    expect(fold([sentence(100, 0, 'New.'), started(110, 0)], settled).caption?.text).toBe('New.');
  });

  it('shows their recognised words as theirs, and keeps them through a barge-in', () => {
    const heard = fold([{ ...base(0), type: 'user.transcript', text: 'what time is it', isFinal: true, confidence: null }]);
    expect(heard.caption).toEqual({ speaker: 'you', text: 'what time is it', sentenceIndex: null, endedAt: T0 });
    expect(reduceCaptions(heard, { ...base(10), type: 'assistant.interrupted', spokenPrefix: '' }).caption?.speaker).toBe('you');
    // Her answer replaces it once she is heard.
    expect(fold([sentence(20, 0, 'Noon.'), started(30, 0)], heard).caption?.speaker).toBe('her');
  });

  it('an interim transcript shows without an end; an empty one is nothing', () => {
    const interim = fold([{ ...base(0), type: 'user.transcript', text: 'what ti', isFinal: false, confidence: null }]);
    expect(interim.caption).toMatchObject({ speaker: 'you', endedAt: null });
    expect(reduceCaptions(interim, { ...base(5), type: 'user.transcript', text: '  ', isFinal: true, confidence: null })).toBe(interim);
  });

  it('does not caption typed messages or backchannels', () => {
    const state = emptyCaptions();
    expect(reduceCaptions(state, { ...base(0), type: 'user.message', text: 'typed' })).toBe(state);
    expect(reduceCaptions(state, { ...base(0), type: 'assistant.backchannel', text: 'yeah' })).toBe(state);
  });
});
