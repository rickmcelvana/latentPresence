import { z } from 'zod';
import { DurationMsSchema } from './common';

/**
 * This module is where the zod/TypeScript line is easiest to see.
 *
 * A word timing is written into the transcript and read back from the database, so it
 * is a schema. A block of PCM is handed from a worker to an AudioWorklet inside one
 * process and is never serialised, so it is a plain interface: parsing forty thousand
 * samples on every chunk would cost more than the pipeline it feeds.
 */

/** Where a word sits in synthesised or transcribed audio, relative to its start. */
export const WordTimingSchema = z.object({
  text: z.string().min(1),
  startMs: DurationMsSchema,
  endMs: DurationMsSchema,
});
export type WordTiming = z.infer<typeof WordTimingSchema>;

/** A block of mono PCM. In-process only. */
export interface AudioChunk {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** Offset from the start of the stream, so transcripts and visemes can be aligned. */
  readonly startMs: number;
}

/** Audio out of a TTS or omni provider, with timings when the backend supplies them. */
export interface SpokenAudioChunk extends AudioChunk {
  readonly words?: readonly WordTiming[];
  /** True on the last chunk of an utterance, so the queue knows when to release. */
  readonly isFinal: boolean;
}
