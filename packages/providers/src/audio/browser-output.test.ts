import { describe, expect, it } from 'vitest';
import type { PlaybackEvent } from '@latentpresence/core';
import { BrowserAudioOutput, DUCK_GAIN } from './browser-output';
import type { PlaybackPort, PlaybackRequest, PlaybackResponse } from './messages';
import { PlaybackRenderer } from './renderer';

const RATE = 24_000;
const BLOCK = 128;

/**
 * The audio thread, simulated: a real `PlaybackRenderer` behind the port, rendered in
 * quanta on demand, stamping times exactly as `playback.worklet.ts` does.
 */
class FakeWorklet implements PlaybackPort {
  readonly renderer = new PlaybackRenderer();
  readonly posted: { message: PlaybackRequest; transfer: readonly Transferable[] }[] = [];
  readonly output: number[] = [];
  /** Context time of the next block, in seconds. */
  time = 0;
  private recording = false;
  private readonly listeners = new Set<(message: PlaybackResponse) => void>();

  post(message: PlaybackRequest, transfer: readonly Transferable[] = []): void {
    this.posted.push({ message, transfer });
    if (message.type === 'enqueue') this.renderer.enqueue(message.id, message.samples);
    else if (message.type === 'gain') this.renderer.setGain(message.target, message.frames);
    else if (message.type === 'fade') this.renderer.fade(message.frames);
    else this.recording = message.on;
  }

  onMessage(listener: (message: PlaybackResponse) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Render at least `frames`, a whole quantum at a time. */
  render(frames: number): void {
    for (let done = 0; done < frames; done += BLOCK) {
      const out = new Float32Array(BLOCK);
      const report = this.renderer.render(out);
      const at = (offset: number): number => this.time + offset / RATE;
      for (const { id, offset } of report.started) this.emit({ type: 'started', id, time: at(offset) });
      for (const { id, offset } of report.ended) this.emit({ type: 'ended', id, time: at(offset) });
      if (report.faded !== null) this.emit({ type: 'faded', time: at(report.faded) });
      if (this.recording) this.emit({ type: 'recorded', samples: out.slice(), time: this.time });
      this.output.push(...out);
      this.time += BLOCK / RATE;
    }
  }

  private emit(message: PlaybackResponse): void {
    for (const listener of this.listeners) listener(message);
  }
}

function make(outputLatency = 0) {
  const worklet = new FakeWorklet();
  const output = new BrowserAudioOutput({
    port: worklet,
    sampleRate: RATE,
    clock: () => worklet.time,
    outputLatency: () => outputLatency,
  });
  const events: PlaybackEvent[] = [];
  output.subscribe((event) => events.push(event));
  return { worklet, output, events };
}

describe('BrowserAudioOutput', () => {
  it('queues sentences, transfers their buffers, and reports when each reaches the listener', () => {
    const { worklet, output, events } = make(0.04);
    const samples = new Float32Array(2400).fill(0.5);
    const id = output.enqueue({ samples, sampleRate: RATE });
    expect(worklet.posted[0]?.transfer).toEqual([samples.buffer]);

    worklet.render(2560);
    // Started on frame 0, ended on frame 2400 = 100 ms, each 40 ms later at the ear.
    expect(events.map((e) => [e.type, e.id])).toEqual([
      ['started', id],
      ['ended', id],
    ]);
    expect(events[0]?.at).toBeCloseTo(40, 9);
    expect(events[1]?.at).toBeCloseTo(140, 9);
  });

  it('knows where playback is from the context clock, in the segment’s own frames', () => {
    const { worklet, output } = make();
    expect(output.position()).toBeNull();
    const id = output.enqueue({ samples: new Float32Array(12_000).fill(0.5), sampleRate: RATE });
    worklet.render(1024);
    expect(output.position()).toEqual({ id, frame: 1024 });
    worklet.render(12_000);
    expect(output.position()).toBeNull();
  });

  it('resamples a sentence at another rate once, and counts position in its original frames', () => {
    const { worklet, output } = make();
    const id = output.enqueue({ samples: new Float32Array(6000).fill(0.5), sampleRate: 12_000 });
    const posted = worklet.posted[0]?.message;
    expect(posted?.type === 'enqueue' ? posted.samples.length : null).toBe(12_000);
    worklet.render(2048);
    expect(output.position()).toEqual({ id, frame: 1024 });
  });

  it('ducks and restores with ramps sized in frames', () => {
    const { worklet, output } = make();
    output.duck();
    output.unduck();
    expect(worklet.posted.map((p) => p.message)).toEqual([
      { type: 'gain', target: DUCK_GAIN, frames: 720 },
      { type: 'gain', target: 1, frames: 1920 },
    ]);
  });

  it('fades once however often it is asked, and resolves when the worklet reaches silence', async () => {
    const { worklet, output } = make();
    output.enqueue({ samples: new Float32Array(24_000).fill(0.5), sampleRate: RATE });
    worklet.render(512);
    let done = false;
    const first = output.fadeOut(100);
    const second = output.fadeOut(100);
    expect(second).toBe(first);
    void first.then(() => {
      done = true;
    });
    expect(worklet.posted.filter((p) => p.message.type === 'fade')).toHaveLength(1);

    worklet.render(2048);
    await Promise.resolve();
    expect(done).toBe(false);
    worklet.render(512);
    await Promise.resolve();
    expect(done).toBe(true);
    expect(worklet.output.slice(512 + 2400).every((v) => v === 0)).toBe(true);
    // A new fade after the last one finished is a new fade.
    expect(output.fadeOut(100)).not.toBe(first);
  });

  it('streams what the worklet rendered while recording, and stops when nobody listens', () => {
    const { worklet, output } = make();
    const blocks: number[] = [];
    const stop = output.record((samples) => blocks.push(samples.length));
    worklet.render(256);
    stop();
    worklet.render(256);
    expect(blocks).toEqual([128, 128]);
    expect(worklet.posted.map((p) => p.message)).toEqual([
      { type: 'record', on: true },
      { type: 'record', on: false },
    ]);
  });
});
