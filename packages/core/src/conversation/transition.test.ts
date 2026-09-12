import { describe, expect, it } from 'vitest';
import { conversationEventTypes, type ConversationState } from '@latentpresence/protocol';
import { transition, transitionTable, type ConversationTrigger } from './transition';

const states: ConversationState[] = ['idle', 'listening', 'thinking', 'speaking', 'interrupted'];
const triggers = conversationEventTypes as unknown as ConversationTrigger[];

describe('transition table', () => {
  it('has a row for every one of the five states', () => {
    expect(Object.keys(transitionTable).toSorted()).toEqual([...states].toSorted());
  });

  it('declared transitions land exactly where the table says', () => {
    for (const from of states) {
      for (const trigger of triggers) {
        const expected = transitionTable[from][trigger] ?? from;
        expect(transition(from, trigger)).toBe(expected);
      }
    }
  });

  it('never produces a state the machine does not have', () => {
    for (const from of states) {
      for (const trigger of triggers) {
        expect(states).toContain(transition(from, trigger));
      }
    }
  });

  it('starts listening on session.started (idle → listening)', () => {
    expect(transition('idle', 'session.started')).toBe('listening');
  });

  it('hands an utterance to the model (listening → thinking)', () => {
    expect(transition('listening', 'user.turn.ended')).toBe('thinking');
    expect(transition('listening', 'user.message')).toBe('thinking');
  });

  it('starts speaking when output becomes audible (thinking → speaking)', () => {
    expect(transition('thinking', 'assistant.audio.started')).toBe('speaking');
  });

  it('barges in during thinking straight back to listening', () => {
    // Before any audio exists there is nothing to tear down, so the model turn is
    // cancelled and the machine goes straight to capturing the user (P1-T01).
    expect(transition('thinking', 'user.speech.started')).toBe('listening');
  });

  it('barges in during speaking through the interrupted state', () => {
    // Audio is playing, so the cut-off is explicit; the machine passes through
    // `interrupted` (the teardown seam) before returning to listening.
    expect(transition('speaking', 'user.speech.started')).toBe('interrupted');
    expect(transition('speaking', 'assistant.interrupted')).toBe('interrupted');
  });

  it('returns to listening when a turn ends naturally (speaking → listening)', () => {
    expect(transition('speaking', 'assistant.audio.ended')).toBe('listening');
  });

  it('treats a complete interjection as its own turn (interrupted → thinking)', () => {
    expect(transition('interrupted', 'user.turn.ended')).toBe('thinking');
  });

  it('returns to idle from any active state on session.ended', () => {
    for (const from of ['listening', 'thinking', 'speaking', 'interrupted'] as const) {
      expect(transition(from, 'session.ended')).toBe('idle');
    }
  });

  it('leaves state unchanged for events that do not move it', () => {
    // Progress, transcript and tool/affect traffic pass through but do not transition.
    expect(transition('listening', 'assistant.token')).toBe('listening');
    expect(transition('idle', 'assistant.audio.started')).toBe('idle');
    expect(transition('thinking', 'assistant.sentence')).toBe('thinking');
  });
});
