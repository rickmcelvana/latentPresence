import { describe, expect, it } from 'vitest';
import {
  AffectDirectiveSchema,
  AffectStateSchema,
  CharacterEmotionSchema,
  EmotionEventSchema,
  ExpressionWeightsSchema,
  MoodSchema,
  UserAffectSchema,
} from './affect';

const mood = { pleasure: 0.4, arousal: -0.1, dominance: 0.2 };

describe('MoodSchema', () => {
  it('keeps PAD on its axes', () => {
    expect(MoodSchema.parse(mood)).toEqual(mood);
    // A runaway integrator in the affect engine must not be able to persist a mood
    // outside the space the expression mapping is defined over.
    const out = MoodSchema.safeParse({ ...mood, pleasure: 1.4 });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['pleasure']);
  });
});

describe('EmotionEventSchema', () => {
  const event = {
    label: 'curiosity',
    intensity: 0.6,
    source: 'llm-tag',
    at: '2026-09-08T10:00:00Z',
    halfLifeMs: 30_000,
  };

  it('round-trips an event the LLM tagged', () => {
    expect(EmotionEventSchema.parse(event)).toEqual(event);
  });

  it('rejects a label outside the vocabulary the renderer can show', () => {
    // The LLM will invent labels. They have to be caught here, not discovered as a
    // silently missing expression on the face.
    const out = EmotionEventSchema.safeParse({ ...event, label: 'schadenfreude' });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['label']);
  });

  it('refuses an event that never decays', () => {
    expect(EmotionEventSchema.safeParse({ ...event, halfLifeMs: 0 }).success).toBe(false);
  });
});

describe('AffectStateSchema', () => {
  it('round-trips the persisted state', () => {
    const state = {
      characterId: 'alice',
      mood,
      events: [
        {
          label: 'joy',
          intensity: 0.8,
          source: 'conversation',
          at: '2026-09-08T10:00:00Z',
          halfLifeMs: 60_000,
        },
      ],
      energy: 0.7,
      stance: { warmth: 0.5, formality: -0.2, engagement: 0.6 },
      updatedAt: '2026-09-08T10:00:01Z',
    };
    expect(AffectStateSchema.parse(state)).toEqual(state);
  });

  it('will not persist a state missing its stance', () => {
    const out = AffectStateSchema.safeParse({
      characterId: 'alice',
      mood,
      events: [],
      energy: 0.5,
      updatedAt: '2026-09-08T10:00:01Z',
    });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['stance']);
  });
});

describe('UserAffectSchema', () => {
  it('carries the readings it was fused from', () => {
    const affect = {
      valence: 0.3,
      arousal: 0.5,
      confidence: 0.62,
      label: 'happy',
      readings: [
        { channel: 'voice', valence: 0.4, arousal: 0.6, confidence: 0.7, label: 'happy' },
        { channel: 'text', valence: 0.2, arousal: 0.3, confidence: 0.5, label: 'neutral' },
      ],
      at: '2026-09-08T10:00:00Z',
    };
    expect(UserAffectSchema.parse(affect)).toEqual(affect);
  });

  it('rejects a channel we do not sense', () => {
    // Anything not in this list would be a channel with no consent story behind it.
    const out = UserAffectSchema.safeParse({
      valence: 0,
      arousal: 0,
      confidence: 0,
      label: 'unknown',
      readings: [{ channel: 'heartrate', valence: 0, arousal: 0, confidence: 0, label: 'unknown' }],
      at: '2026-09-08T10:00:00Z',
    });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['readings', 0, 'channel']);
  });
});

describe('ExpressionWeightsSchema', () => {
  it('takes only the expressions being driven', () => {
    expect(ExpressionWeightsSchema.parse({ happy: 0.8, mouthSmile: 0.4 })).toEqual({
      happy: 0.8,
      mouthSmile: 0.4,
    });
    expect(ExpressionWeightsSchema.parse({})).toEqual({});
  });

  it('rejects a name the renderer has no mapping for', () => {
    // A typo here would be a weight written every frame to nothing at all.
    expect(ExpressionWeightsSchema.safeParse({ smirk: 0.5 }).success).toBe(false);
    expect(ExpressionWeightsSchema.safeParse({ happy: 1.2 }).success).toBe(false);
  });
});

describe('AffectDirectiveSchema', () => {
  it('caps the system note so a mood cannot eat the context window', () => {
    const directive = {
      expression: { happy: 0.5 },
      gaze: 'user',
      gestureBias: ['open', 'lean-in'],
      voice: { label: 'joy', intensity: 0.5, energy: 0.6 },
      systemNote: 'You feel bright and a little curious.',
    };
    expect(AffectDirectiveSchema.parse(directive)).toEqual(directive);
    expect(
      AffectDirectiveSchema.safeParse({ ...directive, systemNote: 'x'.repeat(401) }).success,
    ).toBe(false);
  });
});

describe('CharacterEmotionSchema', () => {
  it('stays small enough for a model to hit reliably', () => {
    // The tag protocol (P1-T12) asks the LLM to pick from this list in every turn.
    // If it grows past a dozen, reliability drops and the mapping table gets guessy.
    expect(CharacterEmotionSchema.options.length).toBeLessThanOrEqual(12);
    expect(CharacterEmotionSchema.options).toContain('neutral');
  });
});
