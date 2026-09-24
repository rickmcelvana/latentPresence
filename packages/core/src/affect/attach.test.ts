import type { ConversationEvent, InlineTag } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { attachAffect } from './attach';
import { DEFAULT_AFFECT_PARAMS } from './params';

const T0 = Date.parse('2026-09-24T12:00:00.000Z');

/** A bus with a hand-set wall clock. */
function rig() {
  const listeners = new Set<(event: ConversationEvent) => void>();
  const clock = { now: T0 };
  const machine = {
    subscribe(listener: (event: ConversationEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const say = (tags: InlineTag[]) => {
    const event = { type: 'assistant.sentence', sessionId: 's', at: new Date(clock.now).toISOString(), text: 'Oh.', index: 0, tags } as ConversationEvent;
    for (const listener of listeners) listener(event);
  };
  const affect = attachAffect(machine, { characterId: 'alice', now: () => clock.now });
  return { affect, clock, say, listeners };
}

const sad: InlineTag = { kind: 'emote', value: 'sadness', known: 'sadness', offset: 0 };

describe('attachAffect', () => {
  it('starts at the baseline and stays there with nothing said', () => {
    const { affect, clock } = rig();
    clock.now += 10 * 60_000;
    expect(affect.state().mood).toEqual(DEFAULT_AFFECT_PARAMS.baseline.mood);
    expect(affect.feeling()).toEqual({ label: 'neutral', intensity: 0 });
    expect(affect.voiceStyle({ tags: [] }).rate).toBeCloseTo(1, 10);
  });

  it('feels the tags on the bus: a run of sad answers lowers her, and she drifts back over minutes', () => {
    const { affect, clock, say } = rig();
    for (let i = 0; i < 6; i += 1) {
      say([sad]);
      clock.now += 15_000;
    }
    const low = affect.state().mood.pleasure;
    expect(low).toBeLessThan(DEFAULT_AFFECT_PARAMS.baseline.mood.pleasure - 0.3);
    expect(affect.feeling().label).toBe('sadness');
    expect(affect.voiceStyle({ tags: [] }).rate).toBeLessThan(1);

    clock.now += 20 * 60_000;
    const later = affect.state().mood.pleasure;
    expect(later).toBeGreaterThan(low);
    expect(later).toBeLessThan(DEFAULT_AFFECT_PARAMS.baseline.mood.pleasure);
    clock.now += 24 * 60 * 60_000;
    expect(affect.state().mood.pleasure).toBeCloseTo(DEFAULT_AFFECT_PARAMS.baseline.mood.pleasure, 2);
  });

  it('stops listening when detached', () => {
    const { affect, say, listeners } = rig();
    affect.detach();
    expect(listeners.size).toBe(0);
    say([sad]);
    expect(affect.state().events).toEqual([]);
  });
});
