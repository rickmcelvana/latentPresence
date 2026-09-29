import type { ConversationEvent, InlineTag } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { attachAffect } from '../affect/attach';
import { DEFAULT_AFFECT_PARAMS } from '../affect/params';
import { FakeMemoryStore } from '../memory/fake-store';
import { MOOD_BLOCK, attachMood } from './mood';
import { SelfNotes } from './notes';

const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const BASE = DEFAULT_AFFECT_PARAMS.baseline.mood.pleasure;
const sad: InlineTag = { kind: 'emote', value: 'sadness', known: 'sadness', offset: 0 };

/** One visit: a bus, a wall clock, her affect and her saved mood, over a store that outlives it. */
function visit(store: FakeMemoryStore, clock: { now: number }) {
  const listeners = new Set<(event: ConversationEvent) => void>();
  const machine = {
    subscribe(listener: (event: ConversationEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const send = (event: Record<string, unknown>) => {
    for (const listener of listeners) listener({ sessionId: 's', at: new Date(clock.now).toISOString(), ...event } as ConversationEvent);
  };
  const affect = attachAffect(machine, { characterId: 'alice', now: () => clock.now });
  const errors: Error[] = [];
  const notes = new SelfNotes({ store, characterId: 'alice', now: () => new Date(clock.now) });
  const mood = attachMood(machine, { affect, notes, now: () => clock.now, onError: (error) => errors.push(error) });
  /** An answer of sad sentences, then the answer itself — which is when the mood is saved. */
  const sadAnswer = () => {
    for (let i = 0; i < 3; i += 1) send({ type: 'assistant.sentence', text: 'Oh.', index: i, tags: [sad] });
    send({ type: 'assistant.message', entry: { id: `a-${clock.now}`, role: 'assistant', text: 'Oh.', at: new Date(clock.now).toISOString(), spokenPrefix: null } });
  };
  return { affect, mood, errors, send, sadAnswer };
}

describe('mood across a restart (P4-T06 done-when)', () => {
  it('a visit that ends sad starts the next one still sad, a minute later — and herself again a week later', async () => {
    const store = new FakeMemoryStore();
    const clock = { now: T0 };

    const first = visit(store, clock);
    expect(await first.mood.restored).toBe(false); // nothing saved yet
    for (let i = 0; i < 3; i += 1) {
      first.sadAnswer();
      clock.now += 15_000;
    }
    await first.mood.save();
    const leftAt = first.affect.state().mood.pleasure;
    expect(leftAt).toBeLessThan(BASE - 0.3);
    expect(first.errors).toEqual([]);

    // A restart: a new page, a new engine at her baseline, the same store.
    clock.now += 60_000;
    const second = visit(store, clock);
    expect(second.affect.state().mood.pleasure).toBeCloseTo(BASE, 5);
    expect(await second.mood.restored).toBe(true);
    const restored = second.affect.state().mood.pleasure;
    expect(restored).toBeLessThan(BASE - 0.2);
    // Exactly where she would be had the first visit never closed: the gap is lived, not skipped.
    expect(restored).toBeCloseTo(first.affect.state().mood.pleasure, 6);
    expect(second.affect.feeling().label).toBe('sadness');

    // A week away instead.
    clock.now += 7 * 24 * 60 * 60_000;
    const third = visit(store, clock);
    expect(await third.mood.restored).toBe(true);
    expect(third.affect.state().mood.pleasure).toBeCloseTo(BASE, 2);
  });

  it('keeps what she has felt this visit over a saved mood that arrives late', async () => {
    const store = new FakeMemoryStore();
    const clock = { now: T0 };
    const first = visit(store, clock);
    first.sadAnswer();
    await first.mood.save();

    const second = visit(store, clock);
    // Something is felt before the store has answered.
    second.send({ type: 'assistant.sentence', text: 'Ha!', index: 0, tags: [{ kind: 'emote', value: 'joy', known: 'joy', offset: 0 }] });
    expect(await second.mood.restored).toBe(false);
    expect(second.affect.feeling().label).toBe('joy');
  });

  it('saves nothing until the restore has had its say, so the baseline never overwrites the saved mood', async () => {
    const store = new FakeMemoryStore();
    const clock = { now: T0 };
    const first = visit(store, clock);
    first.sadAnswer();
    first.sadAnswer();
    await first.mood.save();
    const saved = (await store.readBlocks('alice')).find((block) => block.name === MOOD_BLOCK)?.content;

    const second = visit(store, clock);
    void second.mood.save(); // asked immediately, before the restore resolves
    await second.mood.restored;
    await second.mood.save();
    const after = JSON.parse((await store.readBlocks('alice')).find((block) => block.name === MOOD_BLOCK)?.content ?? '{}') as { mood: { pleasure: number } };
    expect(after.mood.pleasure).toBeCloseTo((JSON.parse(saved ?? '{}') as { mood: { pleasure: number } }).mood.pleasure, 1);
  });

  it('starts at her baseline, and says why, when the saved mood is unreadable', async () => {
    const store = new FakeMemoryStore();
    await store.writeBlock({ characterId: 'alice', name: MOOD_BLOCK, content: '{"not":"a mood"}', updatedAt: new Date(T0).toISOString(), editableByCharacter: false });
    const clock = { now: T0 };
    const v = visit(store, clock);
    expect(await v.mood.restored).toBe(false);
    expect(v.errors).toHaveLength(1);
    expect(v.affect.state().mood.pleasure).toBeCloseTo(BASE, 5);
  });

  it('stores the mood as a system block the character cannot see or write', async () => {
    const store = new FakeMemoryStore();
    const clock = { now: T0 };
    const v = visit(store, clock);
    v.sadAnswer();
    await v.mood.save();
    const block = (await store.readBlocks('alice')).find((row) => row.name === MOOD_BLOCK);
    expect(block?.editableByCharacter).toBe(false);
    const notes = new SelfNotes({ store, characterId: 'alice' });
    await notes.load();
    expect(notes.notes()).toEqual([]);
    expect(await notes.writeNote(MOOD_BLOCK, 'happy')).toEqual({ ok: false, reason: expect.stringContaining('not a name you can use') });
  });
});
