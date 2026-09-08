import { z } from 'zod';
import type { SttCapabilities } from '../capabilities';
import { UnitIntervalSchema } from '../common';
import type { AudioChunk } from '../media';
import { WordTimingSchema } from '../media';
import type { ProviderCallOptions } from './shared';

/**
 * A transcription result. Partial results arrive while the user is still speaking and
 * are replaced; only `isFinal` results are written to the transcript or to memory.
 */
export const SttResultSchema = z.object({
  text: z.string(),
  isFinal: z.boolean(),
  confidence: UnitIntervalSchema.nullable(),
  /** BCP-47, when the provider detects it. */
  language: z.string().nullable(),
  words: z.array(WordTimingSchema),
});
export type SttResult = z.infer<typeof SttResultSchema>;

/**
 * Speech to text, in a browser worker or against a server. Takes a stream of mic audio
 * rather than a finished buffer so a streaming backend can answer before the turn ends.
 */
export interface STTProvider {
  readonly id: string;
  capabilities(): Promise<SttCapabilities>;
  transcribe(
    audio: AsyncIterable<AudioChunk>,
    options?: ProviderCallOptions,
  ): AsyncIterable<SttResult>;
}
