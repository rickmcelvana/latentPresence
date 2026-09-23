import { describe, expect, it } from 'vitest';
import { AffectStateSchema, CharacterEmotionSchema, type AffectState, type ConversationEvent, type UserAffect } from '@latentpresence/protocol';
import {
  AffectEngine,
  advanceAffect,
  affectInputsFrom,
  applyAffectInput,
  dominantEmotion,
  eventIntensity,
  initialAffect,
  type AffectInput,
} from './engine';
import { DEFAULT_AFFECT_PARAMS as P } from './params';
import { parseAffect, restoreAffect, serializeAffect } from './persist';

const T0 = Date.parse('2026-09-23T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const EMOTIONS = CharacterEmotionSchema.options;

/** mulberry32, so a failing case can be run again from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Anything at all an input may say, including out-of-range nonsense a bug upstream could send. */
function randomInput(next: () => number, at: number): AffectInput {
  const wild = (): number => (next() - 0.5) * 10;
  const pick = next();
  if (pick < 0.55) {
    return {
      type: 'emotion',
      at,
      label: EMOTIONS[Math.floor(next() * EMOTIONS.length)] ?? 'joy',
      intensity: next() < 0.2 ? wild() : next(),
      source: 'llm-tag',
      ...(next() < 0.3 ? { halfLifeMs: Math.floor(next() * 10 * HOUR) } : {}),
    };
  }
  if (pick < 0.7) {
    const affect: UserAffect = { valence: next() * 2 - 1, arousal: next() * 2 - 1, confidence: next(), label: next() < 0.5 ? 'happy' : 'sad', readings: [], at: new Date(at).toISOString() };
    return { type: 'user-affect', at, affect };
  }
  if (pick < 0.85) return { type: 'stance', at, delta: { warmth: wild(), formality: wild(), engagement: wild() } };
  return { type: 'energy', at, delta: wild() };
}

/** A burst of random inputs over up to ten minutes, ticked at random intervals. */
function randomRun(seed: number): { engine: AffectEngine; end: number } {
  const next = random(seed);
  const engine = new AffectEngine(initialAffect('alice', T0));
  let now = T0;
  const count = 1 + Math.floor(next() * 60);
  for (let i = 0; i < count; i += 1) {
    now += Math.floor(next() * 10 * SECOND);
    engine.enqueue(randomInput(next, now));
    if (next() < 0.5) engine.tick(now + Math.floor(next() * 500));
  }
  engine.tick(now + SECOND);
  return { engine, end: now + SECOND };
}

function distanceFromBaseline(state: AffectState): number {
  const b = P.baseline;
  return Math.max(
    Math.abs(state.mood.pleasure - b.mood.pleasure),
    Math.abs(state.mood.arousal - b.mood.arousal),
    Math.abs(state.mood.dominance - b.mood.dominance),
    Math.abs(state.energy - b.energy),
    Math.abs(state.stance.warmth - b.stance.warmth),
    Math.abs(state.stance.formality - b.stance.formality),
    Math.abs(state.stance.engagement - b.stance.engagement),
  );
}

describe('affect — properties (P3-T01 done-when)', () => {
  it('stays inside its ranges and its schema whatever the inputs, 300 random runs', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { engine } = randomRun(seed);
      const state = engine.state;
      const out = AffectStateSchema.safeParse(state);
      if (!out.success) throw new Error(`seed ${seed}: ${out.error.message}`);
      expect(state.events.length, `seed ${seed}`).toBeLessThanOrEqual(P.maxEvents);
    }
  });

  it('stays in range at every step of the way, not only at the end', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed);
      let state = initialAffect('alice', T0);
      for (let i = 0; i < 200; i += 1) {
        state = applyAffectInput(state, randomInput(next, T0), P);
        state = advanceAffect(state, Date.parse(state.updatedAt) + P.stepMs * (1 + Math.floor(next() * 20)));
        expect(AffectStateSchema.safeParse(state).success, `seed ${seed} step ${i}`).toBe(true);
      }
    }
  });

  it('decays to its baseline with nothing happening: within 0.01 a day later, every event gone', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { engine, end } = randomRun(seed);
      const later = engine.tick(end + 24 * HOUR);
      expect(later.events, `seed ${seed}`).toEqual([]);
      expect(distanceFromBaseline(later), `seed ${seed}`).toBeLessThan(0.01);
    }
  });

  it('never moves away from its baseline once nothing is being felt', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const { engine, end } = randomRun(seed);
      let state = engine.tick(end + 30 * MINUTE); // every event has died by now
      expect(state.events).toEqual([]);
      let last = distanceFromBaseline(state);
      for (let i = 0; i < 100; i += 1) {
        state = advanceAffect(state, Date.parse(state.updatedAt) + 7 * SECOND);
        const now = distanceFromBaseline(state);
        expect(now, `seed ${seed}`).toBeLessThanOrEqual(last + 1e-12);
        last = now;
      }
    }
  });

  it('gives the same state however often it is ticked: every frame, or once at the end', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const next = random(seed);
      const inputs: AffectInput[] = [];
      let at = T0;
      for (let i = 0; i < 20; i += 1) {
        at += Math.floor(next() * 5 * SECOND);
        inputs.push(randomInput(next, at));
      }
      const end = at + 2 * MINUTE;
      const often = new AffectEngine(initialAffect('alice', T0));
      const once = new AffectEngine(initialAffect('alice', T0));
      for (const input of inputs) {
        often.enqueue(input);
        once.enqueue(input);
      }
      for (let now = T0; now < end; now += 16) often.tick(now);
      often.tick(end);
      once.tick(end);
      const a = often.state;
      const b = once.state;
      expect(a.updatedAt).toBe(b.updatedAt);
      expect(a.events).toEqual(b.events);
      for (const key of ['pleasure', 'arousal', 'dominance'] as const) expect(a.mood[key]).toBeCloseTo(b.mood[key], 9);
      expect(a.energy).toBeCloseTo(b.energy, 9);
    }
  });
});

describe('affect — behaviour', () => {
  it('starts at the baseline, feeling nothing', () => {
    const state = initialAffect('alice', T0);
    expect(state.mood).toEqual(P.baseline.mood);
    expect(state.events).toEqual([]);
    expect(dominantEmotion(state)).toEqual({ label: 'neutral', intensity: 0 });
  });

  it('halves an event every half-life', () => {
    const event = { label: 'joy' as const, intensity: 0.8, source: 'llm-tag' as const, at: new Date(T0).toISOString(), halfLifeMs: 20 * SECOND };
    expect(eventIntensity(event, T0)).toBeCloseTo(0.8);
    expect(eventIntensity(event, T0 + 20 * SECOND)).toBeCloseTo(0.4);
    expect(eventIntensity(event, T0 + 40 * SECOND)).toBeCloseTo(0.2);
  });

  it('is lifted by joy and lowered by sadness, and says which it feels', () => {
    const feel = (label: 'joy' | 'sadness') => {
      const engine = new AffectEngine(initialAffect('alice', T0));
      engine.enqueue({ type: 'emotion', at: T0, label, intensity: 0.9, source: 'llm-tag' });
      return engine.tick(T0 + 10 * SECOND);
    };
    const happy = feel('joy');
    const sad = feel('sadness');
    expect(happy.mood.pleasure).toBeGreaterThan(P.baseline.mood.pleasure + 0.05);
    expect(sad.mood.pleasure).toBeLessThan(P.baseline.mood.pleasure - 0.05);
    expect(sad.energy).toBeLessThan(happy.energy);
    expect(dominantEmotion(happy).label).toBe('joy');
    expect(dominantEmotion(sad).label).toBe('sadness');
  });

  it('keeps a feeling for its own sake: a mood outlasts the event that caused it', () => {
    const engine = new AffectEngine(initialAffect('alice', T0));
    engine.enqueue({ type: 'emotion', at: T0, label: 'sadness', intensity: 1, source: 'conversation' });
    const after = engine.tick(T0 + 5 * MINUTE);
    expect(dominantEmotion(after).label).toBe('neutral');
    expect(after.mood.pleasure).toBeLessThan(P.baseline.mood.pleasure - 0.05);
  });

  it('lands an input on the first step at or after it, and never before the state', () => {
    const engine = new AffectEngine(initialAffect('alice', T0));
    engine.tick(T0 + SECOND);
    engine.enqueue({ type: 'emotion', at: T0 + 1250, label: 'joy', intensity: 1, source: 'llm-tag' });
    engine.enqueue({ type: 'emotion', at: T0 - HOUR, label: 'curiosity', intensity: 1, source: 'llm-tag' });
    expect(engine.tick(T0 + 1250).events.map((e) => e.label)).toEqual(['curiosity']);
    const state = engine.tick(T0 + 1300);
    expect(state.events.map((e) => [e.label, e.at])).toEqual([
      ['curiosity', new Date(T0 + SECOND).toISOString()],
      ['joy', new Date(T0 + 1300).toISOString()],
    ]);
  });

  it('holds at most maxEvents, dropping the weakest', () => {
    let state = initialAffect('alice', T0);
    for (let i = 0; i < P.maxEvents; i += 1) state = applyAffectInput(state, { type: 'emotion', at: T0, label: 'joy', intensity: 0.5, source: 'llm-tag' });
    state = applyAffectInput(state, { type: 'emotion', at: T0, label: 'concern', intensity: 0.1, source: 'llm-tag' });
    expect(state.events).toHaveLength(P.maxEvents);
    expect(state.events.some((e) => e.label === 'concern')).toBe(false);
    state = applyAffectInput(state, { type: 'emotion', at: T0, label: 'pride', intensity: 0.9, source: 'llm-tag' });
    expect(state.events.some((e) => e.label === 'pride')).toBe(true);
  });

  it('ignores a neutral feeling and a negligible one', () => {
    const state = initialAffect('alice', T0);
    expect(applyAffectInput(state, { type: 'emotion', at: T0, label: 'neutral', intensity: 1, source: 'llm-tag' }).events).toEqual([]);
    expect(applyAffectInput(state, { type: 'emotion', at: T0, label: 'joy', intensity: 0.001, source: 'llm-tag' }).events).toEqual([]);
  });

  it('catches the user’s mood by empathy, in proportion to how sure the reading is', () => {
    const affect = (label: UserAffect['label'], confidence: number): AffectInput => ({
      type: 'user-affect',
      at: T0,
      affect: { valence: 0, arousal: 0, confidence, label, readings: [], at: new Date(T0).toISOString() },
    });
    const state = initialAffect('alice', T0);
    expect(applyAffectInput(state, affect('sad', 0.8)).events[0]).toMatchObject({ label: 'concern', intensity: 0.4, source: 'user-affect' });
    expect(applyAffectInput(state, affect('happy', 1)).events[0]).toMatchObject({ label: 'joy', intensity: 0.5 });
    expect(applyAffectInput(state, affect('unknown', 1)).events).toEqual([]);
  });

  it('turns an [emote:x] tag into a feeling, and ignores gestures and unknown labels', () => {
    const event = {
      type: 'assistant.sentence',
      sessionId: 's',
      at: new Date(T0).toISOString(),
      text: 'Oh, that is lovely.',
      index: 0,
      tags: [
        { kind: 'emote', value: 'joy', known: 'joy', offset: 0 },
        { kind: 'gesture', value: 'nod', known: 'nod', offset: 0 },
        { kind: 'emote', value: 'glee', known: null, offset: 0 },
      ],
    } as ConversationEvent;
    expect(affectInputsFrom(event)).toEqual([{ type: 'emotion', at: T0, label: 'joy', intensity: P.tagIntensity, source: 'llm-tag' }]);
  });
});

describe('affect — persistence', () => {
  it('round-trips through JSON exactly', () => {
    const { engine } = randomRun(7);
    expect(parseAffect(serializeAffect(engine.state))).toEqual(engine.state);
  });

  it('refuses a saved mood outside its range', () => {
    const bad = { ...initialAffect('alice', T0), mood: { pleasure: 3, arousal: 0, dominance: 0 } };
    expect(() => parseAffect(JSON.stringify(bad))).toThrow();
  });

  it('restores as if it had been running: still upset a minute later, herself again a week later', () => {
    const engine = new AffectEngine(initialAffect('alice', T0));
    engine.enqueue({ type: 'emotion', at: T0, label: 'frustration', intensity: 1, source: 'conversation' });
    const saved = serializeAffect(engine.tick(T0 + 20 * SECOND));
    const soon = restoreAffect(saved, T0 + 80 * SECOND);
    const week = restoreAffect(saved, T0 + 7 * 24 * HOUR);
    expect(soon.mood.pleasure).toBeLessThan(P.baseline.mood.pleasure - 0.05);
    expect(week.updatedAt).toBe(new Date(T0 + 7 * 24 * HOUR).toISOString());
    expect(distanceFromBaseline(week)).toBeLessThan(1e-6);
    expect(week).toEqual(advanceAffect(parseAffect(saved), T0 + 7 * 24 * HOUR));
  });
});
