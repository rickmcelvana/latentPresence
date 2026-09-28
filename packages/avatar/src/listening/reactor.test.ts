import { describe, expect, it } from 'vitest';
import type { ConversationEvent, ConversationState, ExpressionWeights, UserAffect, UserEmotion } from '@latentpresence/protocol';
import { DEFAULT_LISTENING_PARAMS, ListeningReactor, applyListening, type ListeningFrame } from './reactor';

const FRAME_MS = 1000 / 60;

function user(label: UserEmotion, valence: number, confidence: number): UserAffect {
  return { label, valence, arousal: 0, confidence, readings: [], at: new Date(0).toISOString() };
}

function event(type: ConversationEvent['type'], extra: Record<string, unknown> = {}): ConversationEvent {
  return { sessionId: 's', at: new Date(0).toISOString(), type, ...extra } as ConversationEvent;
}

function stateTo(to: ConversationState): ConversationEvent {
  return event('state.changed', { from: 'idle', to });
}

/** A reactor already listening, with the user mid-turn since `at`. */
function listening(at = 0): ListeningReactor {
  const reactor = new ListeningReactor();
  reactor.onEvent(stateTo('listening'), at);
  reactor.onEvent(event('user.speech.started'), at);
  return reactor;
}

/** Runs frames from `from` for `ms`, returning the last frame and every gesture started. */
function run(reactor: ListeningReactor, from: number, ms: number, affect: UserAffect | null): { frame: ListeningFrame; gestures: string[]; end: number } {
  let frame = reactor.update(from, affect);
  const gestures = [...frame.gestures];
  let now = from;
  while (now < from + ms) {
    now += FRAME_MS;
    frame = reactor.update(now, affect);
    gestures.push(...frame.gestures);
  }
  return { frame, gestures, end: now };
}

/** mulberry32: a seeded [0, 1) so the property runs are the same every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ListeningReactor — the face', () => {
  it('stays out of the way with nothing to go on', () => {
    const { frame } = run(listening(), 0, 2000, null);
    expect(frame.expression).toEqual({});
    expect(frame.damp).toEqual({});
  });

  it('smiles softly at a happy user once the read has held, not before', () => {
    const reactor = listening();
    const early = run(reactor, 0, 400, user('happy', 0.6, 0.5));
    expect(early.frame.expression.happy ?? 0).toBe(0);
    const later = run(reactor, early.end, 2000, user('happy', 0.6, 0.5));
    expect(later.frame.expression.happy).toBeGreaterThan(0.2);
    expect(later.frame.expression.happy).toBeLessThanOrEqual(0.35);
    expect(later.frame.damp.angry).toBeLessThan(0.05);
  });

  it('meets sadness and anger alike with concern — never a smile, never anger back', () => {
    for (const label of ['sad', 'angry', 'fearful', 'disgusted'] as const) {
      const { frame } = run(listening(), 0, 3000, user(label, -0.6, 0.5));
      expect(frame.expression.happy ?? 0, label).toBe(0);
      expect(frame.expression.angry ?? 0, label).toBe(0);
      expect(frame.expression.browInnerUp, label).toBeGreaterThan(0.2);
      expect(frame.damp.happy, label).toBeLessThan(0.05);
    }
  });

  it('treats a label whose valence points the other way as doubt', () => {
    const { frame } = run(listening(), 0, 3000, user('happy', -0.3, 0.6));
    expect(frame.expression).toEqual({});
  });

  it('scales with confidence: nothing under the floor, full at the top', () => {
    const faint = run(listening(), 0, 3000, user('happy', 0.6, 0.09)).frame.expression.happy ?? 0;
    const middling = run(listening(), 0, 3000, user('happy', 0.6, 0.25)).frame.expression.happy ?? 0;
    const sure = run(listening(), 0, 3000, user('happy', 0.6, 0.9)).frame.expression.happy ?? 0;
    expect(faint).toBe(0);
    expect(middling).toBeGreaterThan(0.1);
    expect(sure).toBeGreaterThan(middling);
  });

  it('lets go once the floor is hers', () => {
    const reactor = listening();
    const heard = run(reactor, 0, 2000, user('sad', -0.6, 0.6));
    expect(heard.frame.expression.sad).toBeGreaterThan(0.2);
    reactor.onEvent(stateTo('thinking'), heard.end);
    const after = run(reactor, heard.end, 4000, user('sad', -0.6, 0.6));
    expect(after.frame.expression.sad ?? 0).toBeLessThan(0.01);
    expect(after.frame.damp.happy ?? 1).toBeGreaterThan(0.98);
  });

  it('drops a smile at once when the user turns, rather than holding it through the settle', () => {
    const reactor = listening();
    const happy = run(reactor, 0, 2000, user('happy', 0.6, 0.6));
    const peak = happy.frame.expression.happy ?? 0;
    const turned = run(reactor, happy.end, 500, user('sad', -0.6, 0.6));
    expect(turned.frame.expression.happy ?? 0).toBeLessThan(peak * 0.7);
  });

  it('damps her own contradicting mood: a bright resting face does not smile at someone upset', () => {
    const { frame } = run(listening(), 0, 4000, user('sad', -0.7, 0.6));
    const face = applyListening({ happy: 0.3, relaxed: 0.2 }, frame);
    expect(face.happy ?? 0).toBeLessThan(0.02);
    expect(face.sad).toBeGreaterThan(0.2);
  });

  /**
   * The done-when as a property. 300 seeded runs of a moody character (a random resting face
   * that may smile or frown) listening to a user whose read changes at random — label,
   * valence, confidence, dropouts. Whenever the read has been steadily and confidently one
   * polarity for long enough to settle and ease, her face must not show the other.
   */
  it('never shows a steady user the opposite of their tone', () => {
    const labels: UserEmotion[] = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];
    const steadyMs = DEFAULT_LISTENING_PARAMS.settleMs + 4 * DEFAULT_LISTENING_PARAMS.releaseMs;
    let checked = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = seeded(seed);
      const reactor = listening();
      const mood: ExpressionWeights = { happy: random() * 0.35, relaxed: random() * 0.3, angry: random() * 0.25, sad: random() * 0.2 };
      let now = 0;
      for (let segment = 0; segment < 12; segment += 1) {
        const label = labels[Math.floor(random() * labels.length)] ?? 'neutral';
        const polarity = label === 'happy' ? 1 : ['sad', 'angry', 'fearful', 'disgusted'].includes(label) ? -1 : 0;
        const valence = polarity === 0 ? random() * 0.4 - 0.2 : polarity * (0.2 + random() * 0.7);
        const read = random() < 0.15 ? null : user(label, valence, 0.4 + random() * 0.6);
        const length = 200 + random() * 5000;
        const end = now + length;
        while (now < end) {
          now += FRAME_MS;
          const face = applyListening(mood, reactor.update(now, read));
          if (read === null || now - (end - length) < steadyMs) continue;
          if (polarity < 0) {
            expect(face.happy ?? 0, `seed ${seed}: smiled at ${label}`).toBeLessThan(0.03);
            expect(face.angry ?? 0, `seed ${seed}: angry back at ${label}`).toBeLessThan(0.03);
            checked += 1;
          } else if (polarity > 0) {
            expect(face.angry ?? 0, `seed ${seed}: frowned at happy`).toBeLessThan(0.03);
            expect(face.sad ?? 0, `seed ${seed}: sad at happy`).toBeLessThan(0.03);
            checked += 1;
          }
        }
      }
    }
    // The property ran on something: thousands of settled frames, not a vacuous pass.
    expect(checked).toBeGreaterThan(10_000);
  });
});

describe('ListeningReactor — prosody', () => {
  it('nods at a pause that sounds unfinished, after enough speech, and not again too soon', () => {
    const reactor = listening(0);
    reactor.pause(0.2, 1000);
    expect(reactor.update(1000, null).gestures).toEqual([]);
    reactor.pause(0.2, 2000);
    expect(reactor.update(2000, null).gestures).toEqual(['nod']);
    reactor.pause(0.2, 4000);
    expect(reactor.update(4000, null).gestures).toEqual([]);
    reactor.pause(0.2, 5600);
    expect(reactor.update(5600, null).gestures).toEqual(['nod']);
  });

  it('does not nod at a turn end, or when the floor is not the user’s', () => {
    const reactor = listening(0);
    reactor.pause(0.9, 3000);
    expect(reactor.update(3000, null).gestures).toEqual([]);
    reactor.onEvent(stateTo('speaking'), 3100);
    reactor.pause(0.2, 4000);
    expect(reactor.update(4000, null).gestures).toEqual([]);
  });

  it('tilts her head for someone clearly sad', () => {
    const reactor = listening(0);
    const { end } = run(reactor, 0, 2000, user('sad', -0.6, 0.6));
    reactor.pause(0.2, end);
    expect(reactor.update(end, user('sad', -0.6, 0.6)).gestures).toEqual(['tilt-head']);
  });

  it('nods with a spoken backchannel, once per pause', () => {
    const reactor = listening(0);
    reactor.pause(0.2, 3000);
    reactor.onEvent(event('assistant.backchannel', { text: 'Yeah.' }), 3000);
    expect(reactor.update(3000, null).gestures).toEqual(['nod']);
    reactor.onEvent(event('assistant.backchannel', { text: 'Yeah.' }), 4500);
    expect(reactor.update(4500, null).gestures).toEqual(['nod']);
  });

  it('reads emphasis against the speaker’s own level, and silence as none', () => {
    const reactor = listening(0);
    let now = 0;
    for (; now < 10_000; now += 32) reactor.level(0.05, now);
    expect(reactor.emphasis()).toBe(0);
    for (const end = now + 600; now < end; now += 32) reactor.level(0.2, now);
    expect(reactor.emphasis()).toBeGreaterThan(0.8);
    for (const end = now + 2000; now < end; now += 32) reactor.level(0, now);
    expect(reactor.emphasis()).toBeLessThan(0.05);
  });

  it('chooses backchannel words that fit, and none while doubtful', () => {
    const reactor = listening(0);
    expect(reactor.phrases()).toBeNull();
    run(reactor, 0, 2000, user('sad', -0.6, 0.6));
    expect(reactor.phrases()).toEqual(['Oh.', 'Yeah.']);
    reactor.onEvent(stateTo('thinking'), 2100);
    expect(reactor.phrases()).toBeNull();
  });
});
