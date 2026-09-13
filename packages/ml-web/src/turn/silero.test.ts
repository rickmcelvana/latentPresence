import * as ort from 'onnxruntime-web';
import { describe, expect, it } from 'vitest';
import { VAD_CONTEXT_SAMPLES, VAD_FRAME_SAMPLES } from './messages';
import { SileroVad, type OrtSessionLike } from './silero';

/**
 * A stand-in graph that records what it was fed and answers with a counter as its state,
 * so a test can see whether the state was carried and which context was prepended.
 * The real graph's behaviour is `live/turn.ts`'s business.
 */
class RecordingSession implements OrtSessionLike {
  readonly inputs: Float32Array[] = [];
  readonly states: number[] = [];
  /** Resolvers for calls held open, so a test can overlap them. */
  readonly held: (() => void)[] = [];
  hold = false;
  answer: unknown = 0.5;

  async run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor | undefined>> {
    const input = feeds['input'];
    const state = feeds['state'];
    if (input === undefined || state === undefined) throw new Error('missing feed');
    this.inputs.push(Float32Array.from(input.data as Float32Array));
    const seen = (state.data as Float32Array)[0] ?? Number.NaN;
    this.states.push(seen);
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    const next = new Float32Array(256).fill(seen + 1);
    return {
      output: new ort.Tensor('float32', Float32Array.from([this.answer as number]), [1, 1]),
      stateN: new ort.Tensor('float32', next, [2, 1, 128]),
    };
  }
}

const frame = (value: number): Float32Array => new Float32Array(VAD_FRAME_SAMPLES).fill(value);

describe('SileroVad', () => {
  it('feeds 576 samples: the previous frame’s last 64, then this frame, as the reference does', async () => {
    const session = new RecordingSession();
    const vad = new SileroVad(session);
    await vad.probability(frame(1));
    await vad.probability(frame(2));

    const [first, second] = session.inputs;
    expect(first?.length).toBe(VAD_CONTEXT_SAMPLES + VAD_FRAME_SAMPLES);
    expect(first?.slice(0, VAD_CONTEXT_SAMPLES).every((value) => value === 0)).toBe(true);
    expect(second?.slice(0, VAD_CONTEXT_SAMPLES).every((value) => value === 1)).toBe(true);
    expect(second?.slice(VAD_CONTEXT_SAMPLES).every((value) => value === 2)).toBe(true);
  });

  it('feeds the bare frame when context is off, reproducing Spikes A and D', async () => {
    const session = new RecordingSession();
    await new SileroVad(session, { context: false }).probability(frame(3));
    expect(session.inputs[0]?.length).toBe(VAD_FRAME_SAMPLES);
  });

  it('carries the recurrent state from one call to the next, and reset clears it', async () => {
    const session = new RecordingSession();
    const vad = new SileroVad(session);
    await vad.probability(frame(0));
    await vad.probability(frame(0));
    await vad.reset();
    await vad.probability(frame(0));
    expect(session.states).toEqual([0, 1, 0]);
    expect(session.inputs[2]?.slice(0, VAD_CONTEXT_SAMPLES).every((value) => value === 0)).toBe(true);
  });

  it('runs overlapping calls one after another, so no state update is lost', async () => {
    const session = new RecordingSession();
    session.hold = true;
    const vad = new SileroVad(session);
    const first = vad.probability(frame(1));
    const second = vad.probability(frame(2));
    await Promise.resolve();
    await Promise.resolve();
    // Only the first has reached the graph; the second is waiting behind it.
    expect(session.inputs).toHaveLength(1);
    session.held.shift()?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.held.shift()?.();
    await second;
    expect(session.states).toEqual([0, 1]);
  });

  it('copies the frame at call time, so the caller may transfer the buffer straight away', async () => {
    const session = new RecordingSession();
    session.hold = true;
    const vad = new SileroVad(session);
    const samples = frame(7);
    const pending = vad.probability(samples);
    samples.fill(0); // what a detached, transferred buffer would look like to us
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.held.shift()?.();
    await pending;
    expect(session.inputs[0]?.slice(VAD_CONTEXT_SAMPLES).every((value) => value === 7)).toBe(true);
  });

  it('refuses a frame of the wrong length', async () => {
    const vad = new SileroVad(new RecordingSession());
    await expect(vad.probability(new Float32Array(480))).rejects.toThrow(/512 samples/u);
  });

  it('refuses an output that is not a probability, and keeps working after', async () => {
    const session = new RecordingSession();
    const vad = new SileroVad(session);
    session.answer = Number.NaN;
    await expect(vad.probability(frame(0))).rejects.toThrow(/not a probability/u);
    session.answer = 0.9;
    await expect(vad.probability(frame(0))).resolves.toBeCloseTo(0.9);
  });
});
