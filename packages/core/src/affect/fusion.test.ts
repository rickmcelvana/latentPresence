import { describe, expect, it } from 'vitest';
import { UserAffectSchema, type AffectReading, type ConversationEvent, type UserAffect } from '@latentpresence/protocol';
import { ConversationMachine } from '../conversation';
import { attachAffect } from './attach';
import { AffectEngine, initialAffect } from './engine';
import { describeUser } from './express';
import { FUSION_LIVE_SESSION } from './fixtures/fusion-live-session';
import { FUSION_SESSION } from './fixtures/fusion-session';
import {
  DEFAULT_FUSION_PARAMS,
  UserAffectFusion,
  attachUserAffect,
  fuseReadings,
  readingWeight,
  recordFusion,
  replayFusion,
  type FusionRecording,
  type TimedReading,
} from './fusion';

function reading(label: AffectReading['label'], confidence: number, channel: AffectReading['channel'] = 'text'): AffectReading {
  const va: Record<string, [number, number]> = {
    neutral: [0, 0],
    happy: [0.7, 0.4],
    sad: [-0.6, -0.4],
    angry: [-0.6, 0.7],
    surprised: [0.1, 0.7],
  };
  const [valence, arousal] = va[label] ?? [0, 0];
  return { channel, label, valence, arousal, confidence };
}

const T0 = Date.parse('2026-09-25T10:00:00Z');

describe('readingWeight', () => {
  it('trusts the model most and the voice least', () => {
    const at = T0;
    const w = (source: TimedReading['source']) => readingWeight({ source, reading: reading('sad', 0.8), at }, at, false);
    expect(w('tag')).toBeGreaterThan(w('text'));
    expect(w('text')).toBeGreaterThan(w('face'));
    expect(w('face')).toBeGreaterThan(w('voice'));
  });

  it("ignores the voice's weak neutral (D-34), and a model that could not tell", () => {
    expect(readingWeight({ source: 'voice', reading: reading('neutral', 0.43, 'voice'), at: T0 }, T0, false)).toBe(0);
    expect(readingWeight({ source: 'voice', reading: reading('neutral', 0.7, 'voice'), at: T0 }, T0, false)).toBeGreaterThan(0);
    expect(readingWeight({ source: 'voice', reading: reading('unknown', 0.9, 'voice'), at: T0 }, T0, false)).toBe(0);
  });

  it('halves the face while the user talks, and fades each source on its own clock', () => {
    const face: TimedReading = { source: 'face', reading: reading('happy', 0.6, 'face'), at: T0 };
    expect(readingWeight(face, T0, true)).toBeCloseTo(readingWeight(face, T0, false) * DEFAULT_FUSION_PARAMS.speakingFace);
    expect(readingWeight(face, T0 + 4000, false)).toBeCloseTo(readingWeight(face, T0, false) / 2);
    const text: TimedReading = { source: 'text', reading: reading('happy', 0.6), at: T0 };
    expect(readingWeight(text, T0 + 4000, false)).toBeGreaterThan(readingWeight(text, T0, false) * 0.95);
  });
});

describe('fuseReadings', () => {
  it('is null with nothing to go on, never a guessed neutral', () => {
    expect(fuseReadings([], T0)).toBeNull();
    expect(fuseReadings([{ source: 'voice', reading: reading('neutral', 0.4, 'voice'), at: T0 }], T0)).toBeNull();
  });

  it('agreeing channels are surer together than either alone', () => {
    const text: TimedReading = { source: 'text', reading: reading('sad', 0.6), at: T0 };
    const face: TimedReading = { source: 'face', reading: reading('sad', 0.5, 'face'), at: T0 };
    const alone = fuseReadings([text], T0);
    const both = fuseReadings([text, face], T0);
    expect(both?.label).toBe('sad');
    expect(both?.confidence ?? 0).toBeGreaterThan(alone?.confidence ?? 1);
  });

  it('a disagreement lowers confidence and lands valence between them', () => {
    const fused = fuseReadings(
      [
        { source: 'tag', reading: reading('sad', 0.7), at: T0 },
        { source: 'face', reading: reading('happy', 0.5, 'face'), at: T0 },
      ],
      T0,
    );
    expect(fused?.label).toBe('sad');
    expect(fused?.valence ?? 0).toBeGreaterThan(-0.6);
    expect(fused?.valence ?? 0).toBeLessThan(0);
    expect(fused?.confidence ?? 1).toBeLessThan(0.6);
    expect(UserAffectSchema.safeParse(fused).success).toBe(true);
  });
});

describe('UserAffectFusion — when it speaks up', () => {
  it("publishes on every turn, and on the model's tag only when it changes the label, once a turn", () => {
    const fusion = new UserAffectFusion();
    expect(fusion.turn('I got the job!!! 🎉', T0)?.label).toBe('happy');
    // The model agrees: nothing new to say.
    expect(fusion.tag(reading('happy', 0.7), T0 + 500)).toBeNull();
    // Next turn, no surface cue; the model reads the situation.
    fusion.turn('my dog died this morning', T0 + 60_000);
    const corrected = fusion.tag(reading('sad', 0.7), T0 + 60_500);
    expect(corrected?.label).toBe('sad');
    expect(fusion.tag(reading('angry', 0.7), T0 + 61_000)).toBeNull();
    expect(fusion.last()?.label).toBe('sad');
  });
});

/** An event as a test writes it: the bus stamps session and time. */
type Payload = ConversationEvent extends infer E ? (E extends ConversationEvent ? Omit<E, 'sessionId' | 'at'> : never) : never;

/** A bus with a real machine behind it, as `/chat` has. */
function liveSession() {
  let clock = T0;
  const machine = new ConversationMachine({ sessionId: 's', characterId: 'alice', now: () => new Date(clock).toISOString() });
  machine.start();
  const published: UserAffect[] = [];
  machine.subscribe((event) => {
    if (event.type === 'affect.user.updated') published.push(event.affect);
  });
  const attached = attachUserAffect(machine, { sessionId: 's' });
  const recorder = recordFusion(attached.fusion);
  const dispatch = (event: Payload, at: number): void => {
    clock = at;
    machine.dispatch({ ...event, sessionId: 's', at: new Date(at).toISOString() } as ConversationEvent);
  };
  return { machine, attached, recorder, published, dispatch };
}

describe('attachUserAffect on a real bus', () => {
  it('turns a typed message into one affect.user.updated, and the engine feels it', () => {
    const s = liveSession();
    const affect = attachAffect(s.machine, { characterId: 'alice', now: () => T0 + 1000 });
    s.dispatch({ type: 'user.message', text: 'this is SO frustrating, nothing works!!' }, T0);
    expect(s.published.map((p) => p.label)).toEqual(['angry']);
    expect(affect.state().events.some((event) => event.source === 'user-affect')).toBe(true);
  });

  it("a spoken turn reaches the prompt before its transcript is published", () => {
    const s = liveSession();
    s.attached.spokenTurn('I am so tired of this', reading('sad', 0.8, 'voice'), T0);
    expect(s.published).toHaveLength(1);
    expect(s.attached.fusion.last()?.readings.some((r) => r.channel === 'voice')).toBe(true);
  });

  it("reads the model's [user:x] from the first sentence of its reply", () => {
    const s = liveSession();
    s.dispatch({ type: 'user.message', text: 'my exam was today' }, T0);
    s.dispatch({ type: 'assistant.sentence', text: 'How did it go?', index: 0, tags: [{ kind: 'user', value: 'fearful', known: 'fearful', offset: 0 }] }, T0 + 800);
    expect(s.published.at(-1)?.label).toBe('fearful');
  });
});

describe('a recorded session reproduces deterministically', () => {
  it('replaying the live recording publishes exactly what the live session did', () => {
    const s = liveSession();
    s.attached.face(reading('happy', 0.5, 'face'), T0);
    s.dispatch({ type: 'user.speech.started' }, T0 + 100);
    s.dispatch({ type: 'user.speech.ended' }, T0 + 2100);
    s.attached.spokenTurn('guess what, I passed', reading('happy', 0.55, 'voice'), T0 + 2600);
    s.dispatch({ type: 'assistant.sentence', text: 'That is wonderful!', index: 0, tags: [{ kind: 'user', value: 'happy', known: 'happy', offset: 0 }] }, T0 + 3500);
    s.dispatch({ type: 'user.message', text: 'but my friend failed and now I feel awful' }, T0 + 40_000);
    s.dispatch({ type: 'assistant.sentence', text: 'Oh no.', index: 0, tags: [{ kind: 'user', value: 'sad', known: 'sad', offset: 0 }] }, T0 + 41_000);

    const recording = JSON.parse(JSON.stringify(s.recorder.recording())) as FusionRecording;
    expect(replayFusion(recording)).toEqual(s.published);
    expect(replayFusion(recording)).toEqual(replayFusion(recording));
  });

  it('the committed recording replays to the committed result, and so does the engine that took it in', () => {
    const published = replayFusion(FUSION_SESSION);
    expect(published.map((p) => [p.label, p.confidence, p.valence, p.arousal])).toMatchSnapshot();

    const engine = new AffectEngine(initialAffect('alice', T0));
    for (const affect of published) engine.enqueue({ type: 'user-affect', at: Date.parse(affect.at), affect });
    const end = engine.tick(Date.parse(published.at(-1)?.at ?? '') + 5000);
    expect({ mood: end.mood, energy: end.energy, events: end.events.map((e) => [e.label, e.intensity]) }).toMatchSnapshot();
  });
});

describe('a session recorded on /chat (P3-T07, glm-5.2:cloud)', () => {
  it('replays to the same answers every time, and they read as the conversation did', () => {
    const published = replayFusion(FUSION_LIVE_SESSION);
    expect(replayFusion(FUSION_LIVE_SESSION)).toEqual(published);
    expect(published.map((p) => [p.label, p.confidence])).toMatchSnapshot();
    // Friday; the flat (the last read carried over, then the model's); his having known (no
    // tag: the heuristic's "unbelievable!!"); missing it (carried over; the model agreed, so
    // nothing more); thanks (":)", then the model's neutral).
    expect(published.map((p) => p.label)).toEqual(['happy', 'happy', 'sad', 'surprised', 'sad', 'happy', 'neutral']);
    // A read carried over from the last message, before the model reads this one, is too
    // weak to be said to the model at all.
    for (const index of [1, 4]) expect(describeUser(published[index] ?? null)).toBeNull();
  });
});

describe('describeUser — the one line the model is told', () => {
  it('says nothing about a neutral or unsure reading', () => {
    const base = { valence: 0, arousal: 0, readings: [reading('neutral', 0.9)], at: '2026-09-25T10:00:00.000Z' };
    expect(describeUser(null)).toBeNull();
    expect(describeUser({ ...base, label: 'neutral', confidence: 0.9 })).toBeNull();
    expect(describeUser({ ...base, label: 'sad', confidence: 0.2 })).toBeNull();
  });

  it('names the feeling in words and where it comes from', () => {
    const line = describeUser({ label: 'sad', confidence: 0.6, valence: -0.6, arousal: -0.4, readings: [reading('sad', 0.7), reading('sad', 0.5, 'voice')], at: '2026-09-25T10:00:00.000Z' });
    expect(line).toBe('They seem down (from what they wrote and how they sound). Let it shape how you answer; do not point it out unless they do.');
    expect(line).not.toMatch(/\d/u);
  });
});
