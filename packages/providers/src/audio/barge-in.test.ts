import { describe, expect, it } from 'vitest';
import { Reply, type ReplyOutcome } from '@latentpresence/core';
import type { LlmRequest, SpokenAudioChunk } from '@latentpresence/protocol';
import { FakeLLMProvider } from '../llm/fake';
import { FakeTTSProvider } from '../tts/fake';
import { BrowserAudioOutput } from './browser-output';
import type { PlaybackPort, PlaybackRequest, PlaybackResponse } from './messages';
import { EDGE_RAMP_FRAMES, PlaybackRenderer } from './renderer';

/**
 * Barge-in through everything but the speakers (P1-T08): the real `Reply` over the real
 * fakes, into `BrowserAudioOutput`, into a real `PlaybackRenderer` rendered a quantum at a
 * time. What it proves is the done-when in node: the output
 * reaches silence inside the fade with no step, and the transcript keeps only the heard words.
 */

const RATE = 24_000;
const BLOCK = 128;

const request: LlmRequest = {
  modelId: 'fake',
  messages: [{ role: 'user', content: 'tell me about the light' }],
  tools: [],
  temperature: null,
  maxOutputTokens: null,
};

class Worklet implements PlaybackPort {
  readonly renderer = new PlaybackRenderer();
  readonly output: number[] = [];
  time = 0;
  private readonly listeners = new Set<(message: PlaybackResponse) => void>();
  post(message: PlaybackRequest): void {
    if (message.type === 'enqueue') this.renderer.enqueue(message.id, message.samples);
    else if (message.type === 'gain') this.renderer.setGain(message.target, message.frames);
    else if (message.type === 'fade') this.renderer.fade(message.frames);
  }
  onMessage(listener: (message: PlaybackResponse) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  render(frames: number): void {
    for (let done = 0; done < frames; done += BLOCK) {
      const out = new Float32Array(BLOCK);
      const report = this.renderer.render(out);
      const emit = (m: PlaybackResponse): void => {
        for (const l of this.listeners) l(m);
      };
      for (const { id, offset } of report.started) emit({ type: 'started', id, time: this.time + offset / RATE });
      for (const { id, offset } of report.ended) emit({ type: 'ended', id, time: this.time + offset / RATE });
      if (report.faded !== null) emit({ type: 'faded', time: this.time + report.faded / RATE });
      this.output.push(...out);
      this.time += BLOCK / RATE;
    }
  }
}

/** A voiced tone, one second, as every sentence's audio. */
function toneChunk(): SpokenAudioChunk {
  const samples = new Float32Array(RATE);
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE + 0.9);
  return { samples, sampleRate: RATE, startMs: 0, isFinal: true };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('barge-in through the real renderer', () => {
  it('fades to silence inside the fade without a step, and keeps only the words heard', async () => {
    const llm = new FakeLLMProvider('fake', {
      script: [
        { type: 'text-delta', text: 'The afternoon light came in low. ' },
        { type: 'text-delta', text: 'It caught the dust. ' },
        { type: 'text-delta', text: 'Nobody moved.' },
        { type: 'finish', reason: 'stop', usage: null },
      ],
    });
    // `script` replays for every sentence, so each gets its own copy of the tone.
    const tts = new FakeTTSProvider('fake', {});
    tts.synthesize = async function* (req) {
      tts.requests.push(req);
      yield toneChunk();
    };
    const worklet = new Worklet();
    const sink = new BrowserAudioOutput({ port: worklet, sampleRate: RATE, clock: () => worklet.time });
    const reply = new Reply(request, { llm, tts, sink, voiceId: 'af_heart' });
    let outcome: ReplyOutcome | null = null;
    void reply.done.then((o) => {
      outcome = o;
    });
    await settle();

    // One sentence and a half: "The afternoon light came in low." is 32 characters over a
    // second, so frame 1.5 s is 12 000 frames into "It caught the dust." (19 characters).
    worklet.render(RATE + 12_000);
    const cutAt = worklet.output.length;
    const cut = reply.interrupt(100);

    // 12 032 rendered + 1200 for half the fade = 13 232 of 24 000 → 10.5 characters: "It caught".
    expect(cut).toEqual({
      status: 'interrupted',
      text: 'The afternoon light came in low. It caught the dust. Nobody moved.',
      spokenPrefix: 'The afternoon light came in low. It caught',
    });

    worklet.render(RATE);
    await settle();
    expect(outcome).toEqual(cut);

    const out = Float32Array.from(worklet.output);
    // Silent within the 100 ms fade (2400 frames), and stays silent: the queue was dropped.
    expect(out.subarray(cutAt + 2400).every((v) => v === 0)).toBe(true);
    expect(Math.abs(out[cutAt - 1] ?? 0)).toBeGreaterThan(0);
    let maxStep = 0;
    for (let i = 1; i < out.length; i += 1) maxStep = Math.max(maxStep, Math.abs((out[i] ?? 0) - (out[i - 1] ?? 0)));
    const toneStep = (0.5 * 2 * Math.PI * 220) / RATE;
    expect(maxStep).toBeLessThanOrEqual(toneStep + 0.5 / EDGE_RAMP_FRAMES);
  });
});
