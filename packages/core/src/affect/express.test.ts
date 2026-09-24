import { AffectStateSchema, type AffectState, type InlineTag } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { applyAffectInput, advanceAffect, initialAffect } from './engine';
import {
  DEFAULT_EXPRESS_PARAMS,
  MAX_SPEED,
  MIN_SPEED,
  affectToVoice,
  describeFeeling,
  feltEmotion,
  styledSpeed,
  talkativeness,
} from './express';

const T0 = Date.parse('2026-09-24T12:00:00.000Z');

/** A state held at a fixed mood, energy and stance, feeling nothing in particular. */
function held(mood: AffectState['mood'], energy: number, stance: Partial<AffectState['stance']> = {}): AffectState {
  const rest = initialAffect('alice', T0);
  return AffectStateSchema.parse({ ...rest, mood, energy, stance: { ...rest.stance, ...stance } });
}

const rest = initialAffect('alice', T0);
const low = held({ pleasure: -0.55, arousal: -0.4, dominance: -0.35 }, 0.25, { engagement: -0.2 });
const bright = held({ pleasure: 0.75, arousal: 0.55, dominance: 0.4 }, 0.9, { engagement: 0.7 });

/** Sixty seconds of a feeling, as tags would keep it alive. */
function felt(label: 'sadness' | 'joy', seconds = 60): AffectState {
  let state = rest;
  for (let s = 0; s < seconds; s += 5) {
    state = applyAffectInput(state, { type: 'emotion', at: T0 + s * 1000, label, intensity: 0.6, source: 'llm-tag' });
    state = advanceAffect(state, T0 + (s + 5) * 1000);
  }
  return state;
}

const emote = (known: InlineTag['known']): InlineTag => ({ kind: 'emote', value: String(known), known, offset: 0 });

describe('feltEmotion', () => {
  it('names nothing at the baseline', () => {
    expect(feltEmotion(rest, T0)).toEqual({ label: 'neutral', intensity: 0, from: 'none' });
  });

  it('names the mood nearest a feeling when the mood is far enough from neutral', () => {
    expect(feltEmotion(low, T0)).toMatchObject({ label: 'sadness', from: 'mood' });
    expect(feltEmotion(bright, T0)).toMatchObject({ label: 'joy', from: 'mood' });
  });

  it('prefers a live feeling to the mood, and lets it go once it has faded', () => {
    const state = applyAffectInput(bright, { type: 'emotion', at: T0, label: 'concern', intensity: 0.8, source: 'llm-tag' });
    expect(feltEmotion(state, T0)).toMatchObject({ label: 'concern', from: 'event' });
    // Two minutes is six half-lives: the concern is gone and the mood speaks again.
    expect(feltEmotion(state, T0 + 120_000)).toMatchObject({ label: 'joy', from: 'mood' });
  });
});

describe('affectToVoice', () => {
  it('leaves the voice as configured at the baseline', () => {
    const style = affectToVoice(rest, T0);
    expect(style.rate).toBeCloseTo(1, 10);
    expect(style.pauseMs).toBe(DEFAULT_EXPRESS_PARAMS.restPauseMs);
    expect(style.hint).toEqual({ label: 'neutral', intensity: 0, energy: rest.energy });
  });

  it('slows and lengthens the pauses when she is low, quickens and shortens them when she is bright', () => {
    const down = affectToVoice(low, T0);
    const up = affectToVoice(bright, T0);
    expect(down.rate).toBeLessThan(0.95);
    expect(up.rate).toBeGreaterThan(1.05);
    expect(down.pauseMs).toBeGreaterThan(300);
    expect(up.pauseMs).toBeLessThan(200);
    expect(down.hint.label).toBe('sadness');
    expect(up.hint.label).toBe('joy');
  });

  it('follows a run of tags through the engine, not only a mood set by hand', () => {
    expect(affectToVoice(felt('sadness'), T0 + 60_000).rate).toBeLessThan(affectToVoice(felt('joy'), T0 + 60_000).rate);
    expect(affectToVoice(felt('sadness'), T0 + 60_000).hint.label).toBe('sadness');
  });

  it("names the sentence's own emote over the mood, so the voice never contradicts the face", () => {
    const style = affectToVoice(bright, T0, [emote('concern')]);
    expect(style.hint).toMatchObject({ label: 'concern', intensity: 0.6 });
    // Pace is the mood's, not the line's: one tag does not swing the tempo.
    expect(style.rate).toBe(affectToVoice(bright, T0).rate);
  });

  it('ignores a gesture tag and an emote nobody knows', () => {
    const gesture: InlineTag = { kind: 'gesture', value: 'nod', known: 'nod', offset: 0 };
    const unknown: InlineTag = { kind: 'emote', value: 'glee', known: null, offset: 0 };
    expect(affectToVoice(bright, T0, [gesture, unknown]).hint.label).toBe('joy');
  });

  it('stays inside its bounds at the extremes', () => {
    for (const corner of [-1, 1]) {
      const state = held({ pleasure: corner, arousal: corner, dominance: corner }, corner < 0 ? 0 : 1);
      const style = affectToVoice(state, T0);
      expect(Math.abs(style.rate - 1)).toBeLessThanOrEqual(DEFAULT_EXPRESS_PARAMS.maxRateShift + 1e-9);
      expect(style.pauseMs).toBeGreaterThanOrEqual(DEFAULT_EXPRESS_PARAMS.minPauseMs);
      expect(style.pauseMs).toBeLessThanOrEqual(DEFAULT_EXPRESS_PARAMS.maxPauseMs);
      expect(style.hint.intensity).toBeLessThanOrEqual(1);
    }
  });
});

describe('styledSpeed', () => {
  it("multiplies the voice's speed and keeps it where Kokoro holds (D-13)", () => {
    expect(styledSpeed(1, null)).toBe(1);
    expect(styledSpeed(1.2, { hint: { label: 'joy', intensity: 1, energy: 1 }, rate: 1.15, pauseMs: 150 })).toBe(MAX_SPEED);
    expect(styledSpeed(0.8, { hint: { label: 'sadness', intensity: 1, energy: 0 }, rate: 0.85, pauseMs: 450 })).toBe(MIN_SPEED);
  });
});

describe('describeFeeling', () => {
  it('says she is her usual self at the baseline, and asks for no particular length', () => {
    const note = describeFeeling(rest, T0);
    expect(note.feeling).toContain('settled, your usual self');
    expect(note.length).toBe('Say as much as the moment needs and no more.');
    expect(talkativeness(rest)).toBeCloseTo(0, 10);
  });

  it('puts two moods into different words and different length biases', () => {
    const down = describeFeeling(low, T0);
    const up = describeFeeling(bright, T0);
    expect(down.feeling).toContain('unhappy');
    expect(down.feeling).toContain('tired and slow');
    expect(down.length).toContain('a sentence or two');
    expect(up.feeling).toContain('happy');
    expect(up.feeling).toContain('lively');
    expect(up.length).toContain('say a bit more');
  });

  it('names a live feeling beside the mood', () => {
    const state = applyAffectInput(rest, { type: 'emotion', at: T0, label: 'surprise', intensity: 0.8, source: 'llm-tag' });
    expect(describeFeeling(state, T0).feeling).toContain('and right now surprised');
  });

  it('never says a number, and fits the directive\'s 400 characters', () => {
    for (const state of [rest, low, bright, felt('sadness'), felt('joy')]) {
      const note = describeFeeling(state, T0);
      const both = `${note.feeling}\n${note.length}`;
      expect(both).not.toMatch(/\d/);
      expect(both.length).toBeLessThanOrEqual(400);
    }
  });
});
