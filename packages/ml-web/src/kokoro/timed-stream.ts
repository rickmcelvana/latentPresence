import { TextSplitterStream, type KokoroTTS } from 'kokoro-js';
import type { WordTiming } from '@latentpresence/protocol';
import { kokoroWordTimings } from './word-timings';

/**
 * kokoro-js's `stream`, with each chunk's word timings (P2-T09).
 *
 * kokoro-js 1.2.1 calls its model as `this.model(inputs)` and keeps only `waveform`; the
 * timestamped export also returns `durations`, which it drops. So the model is wrapped,
 * once per instance, to keep the last call's outputs — `stream` runs one chunk at a time,
 * so the outputs read after a chunk arrives are that chunk's. A model with no `durations`
 * (the plain export) gives `words: null`, and callers fall back to their estimate.
 *
 * The splitter is built here and closed, because `stream(string)` never finishes in
 * 1.2.1 (`docs/SURFACE.md`, 2026-09-08).
 */

export interface TimedChunk {
  readonly text: string;
  readonly phonemes: string;
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** One per whitespace-separated word of `text`, in ms from this chunk's start. */
  readonly words: WordTiming[] | null;
}

interface Outputs {
  durations?: { data: ArrayLike<number> };
}

const captured = new WeakMap<KokoroTTS, { last: Outputs | null }>();

function capture(tts: KokoroTTS): { last: Outputs | null } {
  const existing = captured.get(tts);
  if (existing !== undefined) return existing;
  const box: { last: Outputs | null } = { last: null };
  const holder = tts as unknown as { model: (inputs: unknown) => Promise<Outputs> };
  const model = holder.model;
  holder.model = async (inputs: unknown) => {
    const outputs = await model(inputs);
    box.last = outputs;
    return outputs;
  };
  captured.set(tts, box);
  return box;
}

export async function* speakTimed(
  tts: KokoroTTS,
  text: string,
  options: Parameters<KokoroTTS['stream']>[1],
): AsyncGenerator<TimedChunk> {
  const box = capture(tts);
  const sentences = new TextSplitterStream();
  sentences.push(text);
  sentences.close();
  for await (const chunk of tts.stream(sentences, options)) {
    const samples = Float32Array.from(chunk.audio.audio);
    const durations = box.last?.durations?.data;
    box.last = null;
    const words =
      durations === undefined ? null : kokoroWordTimings(chunk.text, chunk.phonemes, durations, samples.length, chunk.audio.sampling_rate);
    yield { text: chunk.text, phonemes: chunk.phonemes, samples, sampleRate: chunk.audio.sampling_rate, words };
  }
}
