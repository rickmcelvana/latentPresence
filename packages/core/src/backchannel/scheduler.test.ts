import { describe, expect, it } from 'vitest';
import type { ConversationState } from '@latentpresence/protocol';
import { ManualSink, settle } from '../testing/scripted';
import type { TurnEvent } from '../turn/detector';
import type { BackchannelClip } from './clips';
import { BackchannelScheduler, DEFAULT_BACKCHANNEL_CUT_MS, type BackchannelOptions } from './scheduler';

/**
 * The scheduler on hand-written turn events (P1-T09). `voice/session.test.ts` runs it
 * behind the real detector; here each rule is probed at its edge.
 */

const clip = (text: string): BackchannelClip => ({ text, samples: new Float32Array([0.1, 0.2, 0.3]), sampleRate: 24_000 });
const CLIPS = [clip('Yeah.'), clip('Right.'), clip('I see.')];

type Events = TurnEvent<unknown>;
const speechStart = (at: number): Events => ({ type: 'speech-start', turnId: 1, at });
const candidate = (candidateId: number, speechEndAt: number): Events => ({
  type: 'candidate',
  turnId: 1,
  candidateId,
  at: speechEndAt + 128,
  speechEndAt,
  stats: { sampleCount: 0, durationMs: 0, rms: 0, peak: 0, maxProbability: 0.9 },
});
const judged = (candidateId: number, probability: number, at: number): Events => ({
  type: 'judged',
  turnId: 1,
  candidateId,
  probability,
  at,
});
const frame = (probability: number, at = 0) => ({ samples: new Float32Array(512), probability, at });

function rig(options: BackchannelOptions = {}, clips: readonly BackchannelClip[] = CLIPS) {
  const sink = new ManualSink();
  const scheduler = new BackchannelScheduler(sink, clips, { random: () => 0, ...options });
  return {
    sink,
    scheduler,
    /** A turn that started at `start`, and a pause after `speechMs` of it judged `probability`. */
    pause(candidateId: number, start: number, speechMs: number, probability = 0.1, state: ConversationState = 'listening') {
      if (candidateId === 1) scheduler.onTurn(speechStart(start), state);
      scheduler.onTurn(candidate(candidateId, start + speechMs), state);
      return scheduler.onTurn(judged(candidateId, probability, start + speechMs + 160), state);
    },
  };
}

describe('BackchannelScheduler — where a clip goes', () => {
  it('plays a copy of a clip on a pause judged unfinished, after enough speech', () => {
    const r = rig();
    expect(r.pause(1, 0, 3000)).toEqual({ type: 'played', text: 'Yeah.', at: 3160 });
    expect(r.sink.segments).toHaveLength(1);
    const segment = r.sink.segments[0];
    expect(segment?.samples).toEqual(CLIPS[0]?.samples);
    // The sink may transfer what it is given; the bank must keep its own.
    expect(segment?.samples).not.toBe(CLIPS[0]?.samples);
    expect(r.scheduler.active).toBe(true);
  });

  it('does not play on a pause that sounds finished — that is a turn end', () => {
    expect(rig().pause(1, 0, 5000, 0.7)).toBeNull();
    expect(rig().pause(1, 0, 5000, 0.69)).not.toBeNull();
    expect(rig({ threshold: 0.5 }).pause(1, 0, 5000, 0.5)).toBeNull();
  });

  it('does not play before the turn has carried minSpeechMs of speech', () => {
    expect(rig().pause(1, 0, 2999)).toBeNull();
    expect(rig({ minSpeechMs: 1000 }).pause(1, 0, 1000)).not.toBeNull();
  });

  it.each(['idle', 'thinking', 'speaking', 'interrupted'] as const)('does not play while %s', (state) => {
    const r = rig();
    expect(r.pause(1, 0, 5000, 0.1, state)).toBeNull();
    expect(r.sink.segments).toHaveLength(0);
  });

  it('ignores an answer about a candidate that is no longer the live one', () => {
    const r = rig();
    r.scheduler.onTurn(speechStart(0), 'listening');
    r.scheduler.onTurn(candidate(1, 4000), 'listening');
    r.scheduler.onTurn(candidate(2, 5000), 'listening');
    expect(r.scheduler.onTurn(judged(1, 0.1, 5200), 'listening')).toBeNull();
    expect(r.scheduler.onTurn(judged(2, 0.1, 5200), 'listening')).not.toBeNull();
  });

  it('does not play in a turn that has ended, and plays again once it is resumed', () => {
    const r = rig();
    r.scheduler.onTurn(speechStart(0), 'listening');
    r.scheduler.onTurn(candidate(1, 4000), 'listening');
    r.scheduler.onTurn({ type: 'turn-end' } as Events, 'listening');
    expect(r.scheduler.onTurn(judged(1, 0.1, 4200), 'listening')).toBeNull();

    // ADR-25: a resumed turn keeps its start, so its earlier speech still counts.
    r.scheduler.onTurn({ type: 'turn-resumed', turnId: 1, candidateId: 1, at: 4300, pauseMs: 300 }, 'listening');
    r.scheduler.onTurn(candidate(2, 4500), 'listening');
    expect(r.scheduler.onTurn(judged(2, 0.1, 4700), 'listening')).not.toBeNull();
  });

  it('counts speech from the start of the current turn, not an earlier one', () => {
    const r = rig();
    r.scheduler.onTurn(speechStart(0), 'listening');
    r.scheduler.onTurn({ type: 'turn-end' } as Events, 'listening');
    r.scheduler.onTurn(speechStart(10_000), 'listening');
    r.scheduler.onTurn(candidate(2, 11_000), 'listening');
    expect(r.scheduler.onTurn(judged(2, 0.1, 11_200), 'listening')).toBeNull();
  });

  it('never plays with no clips', () => {
    expect(rig({}, []).pause(1, 0, 5000)).toBeNull();
  });
});

describe('BackchannelScheduler — at most one per interval', () => {
  it('refuses a second clip until intervalMs after the first one started', () => {
    const r = rig();
    const first = r.pause(1, 0, 3000);
    r.sink.end(100);
    expect(first?.at).toBe(3160);
    r.scheduler.onTurn(candidate(2, 11_000), 'listening');
    expect(r.scheduler.onTurn(judged(2, 0.1, 3160 + 7999), 'listening')).toBeNull();
    r.scheduler.onTurn(candidate(3, 11_200), 'listening');
    expect(r.scheduler.onTurn(judged(3, 0.1, 3160 + 8000), 'listening')).not.toBeNull();
    expect(r.sink.segments).toHaveLength(2);
  });

  it('never queues a clip behind one still playing, however long ago it started', () => {
    const r = rig({ intervalMs: 0 });
    r.pause(1, 0, 3000);
    r.scheduler.onTurn(candidate(2, 20_000), 'listening');
    expect(r.scheduler.onTurn(judged(2, 0.1, 20_200), 'listening')).toBeNull();
    r.sink.end(100);
    r.scheduler.onTurn(candidate(3, 21_000), 'listening');
    expect(r.scheduler.onTurn(judged(3, 0.1, 21_200), 'listening')).not.toBeNull();
  });

  it('does not say the same clip twice in a row when it has a choice', () => {
    const said = (random: number, clips: readonly BackchannelClip[] = CLIPS): string[] => {
      const r = rig({ intervalMs: 0, random: () => random }, clips);
      r.scheduler.onTurn(speechStart(0), 'listening');
      const texts: string[] = [];
      for (let i = 1; i <= 4; i += 1) {
        r.scheduler.onTurn(candidate(i, i * 4000), 'listening');
        const event = r.scheduler.onTurn(judged(i, 0.1, i * 4000 + 160), 'listening');
        if (event !== null) texts.push(event.text);
        r.sink.end(99 + r.sink.segments.length);
      }
      return texts;
    };
    expect(said(0)).toEqual(['Yeah.', 'Right.', 'Yeah.', 'Right.']);
    expect(said(0.99)).toEqual(['I see.', 'Right.', 'I see.', 'Right.']);
    expect(said(0.5, [clip('Yeah.')])).toEqual(['Yeah.', 'Yeah.', 'Yeah.', 'Yeah.']);
  });
});

describe('BackchannelScheduler — never over user speech', () => {
  it('fades a clip out on the first frame of speech inside the turn, once', async () => {
    const r = rig();
    r.pause(1, 0, 3000);
    expect(r.scheduler.push(frame(0.34, 3200))).toBeNull();
    expect(r.scheduler.push(frame(0.35, 3232))).toEqual({ type: 'overlapped', action: 'duck', text: 'Yeah.', at: 3232 });
    expect(r.scheduler.push(frame(0.9, 3264))).toBeNull();
    // Ducked once and left to finish: a word cut in half sounds like a fault.
    expect(r.sink.gain).toEqual(['duck']);
    expect(r.sink.fades).toEqual([]);
    expect(r.scheduler.active).toBe(true);

    r.sink.end(100);
    expect(r.sink.gain).toEqual(['duck', 'unduck']);
    expect(r.scheduler.active).toBe(false);
  });

  it("with overlap 'cut' fades the clip out instead, as the plan's rule says", async () => {
    const r = rig({ overlap: 'cut' });
    r.pause(1, 0, 3000);
    expect(r.scheduler.push(frame(0.35, 3232))).toEqual({ type: 'overlapped', action: 'cut', text: 'Yeah.', at: 3232 });
    r.scheduler.push(frame(0.9, 3264));
    expect(r.sink.fades).toEqual([DEFAULT_BACKCHANNEL_CUT_MS]);
    expect(r.sink.gain).toEqual([]);
    await settle();
    expect(r.scheduler.active).toBe(false);
  });

  it('once the turn has ended, only what would start a new turn counts as speech', () => {
    const r = rig({ overlap: 'cut', cutMs: 20 });
    r.pause(1, 0, 3000);
    r.scheduler.onTurn({ type: 'turn-end' } as Events, 'listening');
    expect(r.scheduler.push(frame(0.49))).toBeNull();
    expect(r.scheduler.push(frame(0.5))?.type).toBe('overlapped');
    expect(r.sink.fades).toEqual([20]);
  });

  it('does nothing to the output when no clip is playing, and never unducks a clip it did not duck', () => {
    const r = rig();
    r.scheduler.push(frame(0.9));
    r.pause(1, 0, 3000);
    r.sink.end(100);
    r.scheduler.push(frame(0.9));
    expect(r.sink.fades).toEqual([]);
    expect(r.sink.gain).toEqual([]);
  });

  it('gives the gain back if disposed while a ducked clip plays', () => {
    const r = rig();
    r.pause(1, 0, 3000);
    r.scheduler.push(frame(0.9));
    r.scheduler.dispose();
    expect(r.sink.gain).toEqual(['duck', 'unduck']);
  });

  it('forgets a clip the sink dropped for someone else', () => {
    const r = rig({ intervalMs: 0 });
    r.pause(1, 0, 3000);
    r.sink.end(999);
    expect(r.scheduler.active).toBe(true);
    r.sink.end(100);
    expect(r.scheduler.active).toBe(false);
  });

  it('stops listening to the sink when disposed', () => {
    const r = rig();
    expect(r.sink.listenerCount).toBe(1);
    r.scheduler.dispose();
    expect(r.sink.listenerCount).toBe(0);
  });
});

describe('BackchannelScheduler — options', () => {
  it.each([{ intervalMs: -1 }, { minSpeechMs: -1 }, { cutMs: 0 }, { intervalMs: Number.NaN }])('rejects %o', (options) => {
    expect(() => new BackchannelScheduler(new ManualSink(), CLIPS, options)).toThrow(RangeError);
  });
});
