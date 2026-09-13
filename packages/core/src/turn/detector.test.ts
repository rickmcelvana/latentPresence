import { describe, expect, it } from 'vitest';
import type { AudioChunk, CancellationSignal } from '@latentpresence/protocol';
import { TurnDetector, utteranceStats, type TurnEvent, type TurnJudge } from './detector';

/**
 * Every test here is a scripted stream of Silero probabilities with no audio and no model
 * (P1-T07's gate half). The frame geometry is Silero v5's — 512 samples, 32 ms at 16 kHz —
 * so the timings the assertions name are the ones Spike D measured against.
 */
const FRAME = 512;
const FRAME_MS = 32;

/** A deferred judge answer the test resolves when it chooses. */
interface PendingJudgement {
  readonly audio: Float32Array;
  readonly signal: CancellationSignal;
  resolve(probability: number): void;
  reject(error: Error): void;
}

class ScriptedJudge implements TurnJudge {
  readonly calls: PendingJudgement[] = [];
  /** Recorded at call time, so a test can tell what else had already happened. */
  readonly callOrder: string[];

  constructor(callOrder: string[]) {
    this.callOrder = callOrder;
  }

  judge(audio: Float32Array, signal: CancellationSignal): Promise<number> {
    this.callOrder.push('judge');
    return new Promise<number>((resolve, reject) => {
      this.calls.push({ audio, signal, resolve, reject });
    });
  }

  last(): PendingJudgement {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error('judge was never called');
    return call;
  }
}

/** What the recogniser was handed, and the handle returned for it. */
interface Recognition {
  readonly id: number;
  readonly audio: AudioChunk;
  readonly signal: CancellationSignal;
}

/**
 * A stream driver. Each frame's samples are filled with its index, so any buffer the
 * detector hands out can be read back as the list of frames it contains.
 */
function harness(options: { judge?: boolean; recognise?: boolean; candidateMs?: number } = {}) {
  let clock = 0;
  let index = 0;
  const order: string[] = [];
  const judge = new ScriptedJudge(order);
  const recognitions: Recognition[] = [];
  const events: TurnEvent<Recognition>[] = [];

  const detector = new TurnDetector<Recognition>({
    now: () => clock,
    ...(options.judge === false ? {} : { judge }),
    ...(options.recognise === false
      ? {}
      : {
          recognise: (audio: AudioChunk, signal: CancellationSignal): Recognition => {
            order.push('recognise');
            const handle = { id: recognitions.length + 1, audio, signal };
            recognitions.push(handle);
            return handle;
          },
        }),
    ...(options.candidateMs === undefined ? {} : { candidateMs: options.candidateMs }),
  });
  detector.subscribe((event) => {
    order.push(event.type);
    events.push(event);
  });

  const frame = (probability: number): void => {
    const samples = new Float32Array(FRAME).fill(index / 1000);
    const at = index * FRAME_MS;
    clock = at;
    index += 1;
    detector.push({ samples, probability, at });
  };

  return {
    detector,
    judge,
    recognitions,
    events,
    order,
    /** `count` frames at `probability`. */
    frames(count: number, probability: number): void {
      for (let i = 0; i < count; i += 1) frame(probability);
    },
    /** Move the answer clock forward without a frame, as a judge's latency does. */
    advance(ms: number): void {
      clock += ms;
    },
    /** Let resolved judge promises deliver. */
    async settle(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
    },
    of<T extends TurnEvent<Recognition>['type']>(type: T): Extract<TurnEvent<Recognition>, { type: T }>[] {
      return events.filter((event): event is Extract<TurnEvent<Recognition>, { type: T }> => event.type === type);
    },
    get frameIndex(): number {
      return index;
    },
  };
}

/** Which frame indices a buffer was built from, in order. */
function framesIn(audio: Float32Array): number[] {
  const indices: number[] = [];
  for (let offset = 0; offset < audio.length; offset += FRAME) {
    indices.push(Math.round((audio[offset] ?? Number.NaN) * 1000));
  }
  return indices;
}

describe('TurnDetector — speech', () => {
  it('starts speech on the first frame at speechOn, not below it', () => {
    const h = harness();
    h.frames(3, 0.49);
    expect(h.events).toEqual([]);
    h.frames(1, 0.5);
    expect(h.events).toEqual([{ type: 'speech-start', turnId: 1, at: 3 * FRAME_MS }]);
  });

  it('holds speech through frames between speechOff and speechOn (hysteresis)', () => {
    const h = harness();
    h.frames(1, 0.9);
    // 0.4 is below speechOn but above speechOff: still talking, so no pause is counted.
    h.frames(20, 0.4);
    expect(h.of('candidate')).toEqual([]);
    expect(h.of('turn-end')).toEqual([]);
  });

  it('keeps the pre-roll: the ~300 ms before onset heads the utterance', () => {
    const h = harness();
    h.frames(20, 0); // frames 0..19, quiet
    h.frames(5, 0.9); // frames 20..24, speech
    h.frames(4, 0); // frames 25..28, the candidate fires on the fourth
    const audio = h.recognitions[0]?.audio.samples;
    if (audio === undefined) throw new Error('no recognition');
    // 4800 samples is 9.375 frames, so ten frames are kept: nine before onset plus onset.
    expect(framesIn(audio)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
    expect(h.recognitions[0]?.audio.startMs).toBe(11 * FRAME_MS);
  });
});

describe('TurnDetector — candidates', () => {
  it('offers one candidate per pause, on the first frame at least candidateMs after speech', () => {
    const h = harness();
    h.frames(10, 0.9); // last speech at frame 9 = 288 ms
    h.frames(3, 0); // 32, 64, 96 ms of silence
    expect(h.of('candidate')).toEqual([]);
    h.frames(1, 0); // 128 ms
    expect(h.of('candidate')).toHaveLength(1);
    expect(h.of('candidate')[0]).toMatchObject({ turnId: 1, candidateId: 1, at: 13 * FRAME_MS, speechEndAt: 9 * FRAME_MS });
    h.frames(5, 0);
    expect(h.of('candidate')).toHaveLength(1);
    expect(h.judge.calls).toHaveLength(1);
  });

  it('hands the same buffer to recognition and to the judge, in the same synchronous step (ADR-21)', () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0);
    // Both happened inside the push that cut the window, before the candidate was announced.
    expect(h.order).toEqual(['speech-start', 'recognise', 'judge', 'candidate']);
    const recognition = h.recognitions[0];
    const judged = h.judge.last();
    expect(recognition?.audio.samples).toBe(judged.audio);
    expect(recognition?.signal).toBe(judged.signal);
    expect(recognition?.audio.sampleRate).toBe(16_000);
  });

  it('still speculates recognition with no judge configured', () => {
    const h = harness({ judge: false });
    h.frames(10, 0.9);
    h.frames(4, 0);
    expect(h.recognitions).toHaveLength(1);
    h.frames(12, 0); // 512 ms
    const end = h.of('turn-end')[0];
    expect(end).toMatchObject({ reason: 'hangover', probability: null });
    expect(end?.recognition).toBe(h.recognitions[0]);
    expect(h.recognitions).toHaveLength(1);
  });

  it('works with no recogniser, reporting a null recognition', () => {
    const h = harness({ recognise: false });
    h.frames(10, 0.9);
    h.frames(4, 0);
    h.judge.last().resolve(0.9);
    return h.settle().then(() => {
      expect(h.of('turn-end')[0]).toMatchObject({ reason: 'model', recognition: null });
    });
  });
});

describe('TurnDetector — ending a turn', () => {
  it('ends the turn when the judge answers at or over the threshold, keeping the recognition', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0);
    h.advance(40); // Spike D: 22 ms log-mel + 14 ms inference + scheduling
    h.judge.last().resolve(0.7);
    await h.settle();

    expect(h.order.slice(-3)).toEqual(['judged', 'speech-end', 'turn-end']);
    const end = h.of('turn-end')[0];
    expect(end).toMatchObject({
      turnId: 1,
      candidateId: 1,
      reason: 'model',
      probability: 0.7,
      speechStartAt: 0,
      speechEndAt: 9 * FRAME_MS,
      at: 13 * FRAME_MS + 40,
    });
    expect(h.of('speech-end')[0]).toEqual({ type: 'speech-end', turnId: 1, at: 9 * FRAME_MS });
    expect(end?.recognition).toBe(h.recognitions[0]);
    expect(h.recognitions[0]?.signal.aborted).toBe(false);
    expect(end?.audio).toBe(h.judge.last().audio);
  });

  it('meets the done-when: a model-ended turn lands within 300 ms of the labelled end of speech', async () => {
    const h = harness();
    h.frames(40, 0.95); // a sentence, frames 0..39
    const labelledEnd = 39 * FRAME_MS;
    h.frames(4, 0.01);
    h.advance(40);
    h.judge.last().resolve(0.93);
    await h.settle();
    const end = h.of('turn-end')[0];
    if (end === undefined) throw new Error('turn did not end');
    // 128 ms of candidate silence plus the answer's 40 ms: Spike D's 168 ms, by construction.
    expect(end.at - labelledEnd).toBe(168);
    expect(end.at - labelledEnd).toBeLessThanOrEqual(300);
  });

  it('does not end on an answer below threshold; the hangover closes it and keeps the same recognition', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0);
    h.judge.last().resolve(0.49);
    await h.settle();
    expect(h.of('judged')).toHaveLength(1);
    expect(h.of('turn-end')).toEqual([]);

    // Silence is measured from the last speech frame (9): 500 ms is reached at frame 25.
    h.frames(11, 0); // frames 14..24, 480 ms
    expect(h.of('turn-end')).toEqual([]);
    h.frames(1, 0); // frame 25, 512 ms — Spike A's figure
    const end = h.of('turn-end')[0];
    expect(end).toMatchObject({ reason: 'hangover', at: 25 * FRAME_MS, probability: 0.49 });
    // The miss did not throw the transcript away: same handle, never aborted.
    expect(end?.recognition).toBe(h.recognitions[0]);
    expect(h.recognitions).toHaveLength(1);
    expect(h.recognitions[0]?.signal.aborted).toBe(false);
  });

  it('reports an answer that arrives after the hangover as late, fired or not, and never ends a turn twice', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(16, 0); // hangover at frame 25
    expect(h.of('turn-end')).toHaveLength(1);
    const [first, ] = h.judge.calls;
    first?.resolve(0.979); // Spike D's two late answers were both this confident
    await h.settle();
    expect(h.of('late')).toEqual([
      { type: 'late', turnId: 1, candidateId: 1, probability: 0.979, fired: true, at: 25 * FRAME_MS },
    ]);
    expect(h.of('turn-end')).toHaveLength(1);
    expect(h.of('judged')).toEqual([]);
  });

  it('marks a late answer below threshold as not fired', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(16, 0);
    h.judge.last().resolve(0.2);
    await h.settle();
    expect(h.of('late')[0]).toMatchObject({ fired: false, probability: 0.2 });
  });

  it('does not let a late answer for one turn end the next', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(16, 0); // turn 1 closed by the hangover
    const stale = h.judge.last();
    h.frames(10, 0.9); // turn 2 under way
    stale.resolve(0.99);
    await h.settle();
    expect(h.of('late')[0]).toMatchObject({ turnId: 1 });
    expect(h.of('turn-end')).toHaveLength(1);
    expect(h.of('speech-start').map((event) => event.turnId)).toEqual([1, 2]);
  });

  it('starts the next turn cleanly once the last one is past retraction, without the old audio', async () => {
    const h = harness();
    h.frames(10, 0.9); // speech ends at frame 9
    h.frames(4, 0);
    h.judge.last().resolve(0.9);
    await h.settle();
    h.frames(13, 0); // frames 14..26; frame 25 is 512 ms after speech ended
    h.frames(5, 0.9); // frame 27 onward: a new turn
    h.frames(4, 0);
    const second = h.recognitions[1]?.audio.samples;
    if (second === undefined) throw new Error('no second recognition');
    // Ten frames of pre-roll, onset included, and nothing from turn 1.
    expect(framesIn(second)[0]).toBe(18);
    expect(h.of('candidate')[1]).toMatchObject({ turnId: 2, candidateId: 2 });
    expect(h.of('turn-resumed')).toEqual([]);
  });
});

describe('TurnDetector — retracting a model-ended turn (ADR-25)', () => {
  /** Speech to frame 9, a candidate at 13, and the judge ending the turn 40 ms later. */
  async function endedByModel() {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0);
    h.advance(40);
    h.judge.last().resolve(0.96);
    await h.settle();
    return h;
  }

  it('says when each end becomes final', async () => {
    const h = await endedByModel();
    expect(h.of('turn-end')[0]).toMatchObject({ reason: 'model', confirmedAt: 9 * FRAME_MS + 500 });

    const t = harness({ judge: false });
    t.frames(10, 0.9);
    t.frames(16, 0);
    expect(t.of('turn-end')[0]).toMatchObject({ reason: 'hangover', confirmedAt: 25 * FRAME_MS });
  });

  it('retracts the end when speech resumes inside the window, and continues the same turn', async () => {
    const h = await endedByModel();
    const ended = h.recognitions[0];
    h.frames(3, 0); // frames 14..16: the pause runs on
    h.frames(6, 0.95); // frame 17: "…came in low across the desk"
    expect(h.of('turn-resumed')).toEqual([
      { type: 'turn-resumed', turnId: 1, candidateId: 1, at: 17 * FRAME_MS, pauseMs: 8 * FRAME_MS },
    ]);
    expect(ended?.signal.aborted).toBe(true);
    expect(h.of('speech-start')).toHaveLength(1);

    h.frames(4, 0); // speech ended at frame 22; candidate at 26
    const whole = h.recognitions[1]?.audio.samples;
    if (whole === undefined) throw new Error('no second recognition');
    // Every frame from the first word, through the pause, to the new candidate.
    expect(framesIn(whole)).toEqual(Array.from({ length: 27 }, (_, i) => i));
    h.judge.last().resolve(0.97);
    await h.settle();
    expect(h.of('turn-end').map((event) => [event.turnId, event.candidateId, event.speechEndAt])).toEqual([
      [1, 1, 9 * FRAME_MS],
      [1, 2, 22 * FRAME_MS],
    ]);
  });

  it('ignores a late answer for the retracted candidate', async () => {
    const h = await endedByModel();
    h.frames(2, 0.95);
    expect(h.of('turn-resumed')).toHaveLength(1);
    h.frames(4, 0);
    const before = h.events.length;
    // The retracted candidate has no pending answer; the new one is unanswered. Nothing fires.
    await h.settle();
    expect(h.events).toHaveLength(before);
  });

  it('does not retract once the hangover would have closed the turn anyway', async () => {
    const h = await endedByModel();
    h.frames(11, 0); // frames 14..24
    h.frames(3, 0.95); // speech at frame 25: 512 ms after it ended — past the window
    expect(h.of('turn-resumed')).toEqual([]);
    expect(h.of('speech-start').map((event) => event.turnId)).toEqual([1, 2]);
    expect(h.recognitions[0]?.signal.aborted).toBe(false);
  });

  it('still retracts on the last frame inside the window', async () => {
    const h = await endedByModel();
    h.frames(10, 0); // frames 14..23
    h.frames(1, 0.95); // speech at frame 24: 480 ms after it ended
    expect(h.of('turn-resumed')[0]).toMatchObject({ pauseMs: 480 });
  });

  it('needs speechOn to resume, not merely speechOff', async () => {
    const h = await endedByModel();
    h.frames(3, 0.4); // above speechOff, below speechOn: a breath, not a word
    expect(h.of('turn-resumed')).toEqual([]);
  });

  it('never retracts a turn the hangover closed', () => {
    const h = harness({ judge: false });
    h.frames(10, 0.9);
    h.frames(16, 0); // hangover at 25
    h.frames(1, 0.95); // immediately after
    expect(h.of('turn-resumed')).toEqual([]);
    expect(h.of('speech-start')).toHaveLength(2);
  });

  it('stops retraction on reset', async () => {
    const h = await endedByModel();
    h.detector.reset();
    h.frames(2, 0.95);
    expect(h.of('turn-resumed')).toEqual([]);
    expect(h.of('speech-start').map((event) => event.turnId)).toEqual([1, 2]);
  });
});

describe('TurnDetector — speech resuming', () => {
  it('cancels the candidate when speech resumes, and ignores its answer however confident', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0); // candidate 1
    const first = h.judge.last();
    h.frames(3, 0.8); // the person carries on
    expect(first.signal.aborted).toBe(true);
    expect(h.recognitions[0]?.signal.aborted).toBe(true);

    first.resolve(0.99);
    await h.settle();
    expect(h.of('judged')).toEqual([]);
    expect(h.of('turn-end')).toEqual([]);
    expect(h.of('late')).toEqual([]);
  });

  it('offers a fresh candidate for the next pause, over the longer utterance', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0);
    h.frames(3, 0.8);
    h.frames(4, 0);
    expect(h.of('candidate').map((event) => event.candidateId)).toEqual([1, 2]);
    const [first, second] = h.recognitions;
    expect(second?.audio.samples.length).toBe((first?.audio.samples.length ?? 0) + 7 * FRAME);
    h.judge.last().resolve(0.8);
    await h.settle();
    expect(h.of('turn-end')[0]).toMatchObject({ candidateId: 2, recognition: second });
  });

  it('swallows a rejection from a cancelled judgement', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0);
    const first = h.judge.last();
    h.frames(1, 0.9);
    first.reject(new Error('cancelled'));
    await h.settle();
    expect(h.of('judge-error')).toEqual([]);
  });
});

describe('TurnDetector — failures', () => {
  it('reports a judge failure and lets the hangover close the turn', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0);
    h.judge.last().reject(new Error('webgpu device lost'));
    await h.settle();
    expect(h.of('judge-error')).toEqual([
      { type: 'judge-error', turnId: 1, candidateId: 1, message: 'webgpu device lost' },
    ]);
    h.frames(12, 0);
    expect(h.of('turn-end')[0]).toMatchObject({ reason: 'hangover', probability: null });
  });

  it.each([Number.NaN, -0.1, 1.5, Number.POSITIVE_INFINITY])(
    'refuses %s as a probability rather than firing on it',
    async (value) => {
      const h = harness();
      h.frames(10, 0.9);
      h.frames(4, 0);
      h.judge.last().resolve(value);
      await h.settle();
      expect(h.of('turn-end')).toEqual([]);
      expect(h.of('judge-error')).toHaveLength(1);
    },
  );

  it('reports a judge that throws synchronously instead of breaking the frame loop', () => {
    const events: TurnEvent<unknown>[] = [];
    let at = 0;
    const detector = new TurnDetector({
      now: () => at,
      judge: {
        judge: () => {
          throw new Error('not loaded');
        },
      },
    });
    detector.subscribe((event) => events.push(event));
    const push = (probability: number): void => {
      detector.push({ samples: new Float32Array(FRAME), probability, at });
      at += FRAME_MS;
    };
    for (let i = 0; i < 10; i += 1) push(0.9);
    for (let i = 0; i < 20; i += 1) push(0);
    return Promise.resolve().then(() => {
      expect(events.some((event) => event.type === 'judge-error')).toBe(true);
      expect(events.some((event) => event.type === 'turn-end')).toBe(true);
    });
  });

  it('reset drops the utterance, cancels the candidate and emits nothing', async () => {
    const h = harness();
    h.frames(10, 0.9);
    h.frames(4, 0);
    const pending = h.judge.last();
    const before = h.events.length;
    h.detector.reset();
    expect(pending.signal.aborted).toBe(true);
    pending.resolve(0.99);
    await h.settle();
    h.frames(20, 0);
    expect(h.events).toHaveLength(before);
  });

  it('closes on a single frame whose gap jumps past the hangover, offering the candidate first', () => {
    const events: TurnEvent<string>[] = [];
    const detector = new TurnDetector<string>({ now: () => 0, recognise: () => 'r' });
    detector.subscribe((event) => events.push(event));
    detector.push({ samples: new Float32Array(FRAME), probability: 0.9, at: 0 });
    // A tab that was throttled delivers the next frame 700 ms later.
    detector.push({ samples: new Float32Array(FRAME), probability: 0, at: 700 });
    expect(events.map((event) => event.type)).toEqual(['speech-start', 'candidate', 'speech-end', 'turn-end']);
    expect(events.at(-1)).toMatchObject({ reason: 'hangover', recognition: 'r' });
  });
});

describe('TurnDetector — configuration', () => {
  it.each([
    [{ candidateMs: 500 }, /candidateMs < hangoverMs/],
    [{ candidateMs: 600, hangoverMs: 500 }, /candidateMs < hangoverMs/],
    [{ speechOn: 0.3, speechOff: 0.4 }, /speechOff <= speechOn/],
    [{ threshold: 0 }, /threshold/],
    [{ threshold: 1.2 }, /threshold/],
    [{ sampleRate: 0 }, /sampleRate/],
  ])('refuses %o', (options, message) => {
    expect(() => new TurnDetector({ now: () => 0, ...options })).toThrow(message);
  });

  it('honours a shorter candidate silence — ADR-21 names it as the next dial', () => {
    const h = harness({ candidateMs: 60 });
    h.frames(10, 0.9);
    h.frames(2, 0); // 64 ms
    expect(h.of('candidate')).toHaveLength(1);
  });

  it('stops delivering to an unsubscribed listener', () => {
    const detector = new TurnDetector({ now: () => 0 });
    const seen: string[] = [];
    const unsubscribe = detector.subscribe((event) => seen.push(event.type));
    detector.push({ samples: new Float32Array(FRAME), probability: 0.9, at: 0 });
    unsubscribe();
    detector.push({ samples: new Float32Array(FRAME), probability: 0, at: 700 });
    expect(seen).toEqual(['speech-start']);
  });
});

describe('utteranceStats', () => {
  it('measures duration, level and peak', () => {
    const samples = Float32Array.from([0.5, -0.5, 0.5, -1]);
    const stats = utteranceStats(samples, 4, 0.8);
    expect(stats).toEqual({ sampleCount: 4, durationMs: 1000, rms: Math.sqrt(1.75 / 4), peak: 1, maxProbability: 0.8 });
  });

  it('does not divide by zero on an empty buffer', () => {
    expect(utteranceStats(new Float32Array(0), 16_000, 0).rms).toBe(0);
  });
});
