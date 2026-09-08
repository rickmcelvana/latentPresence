import { z } from 'zod';
import { EmotionHintSchema } from '../affect';
import type { TtsCapabilities } from '../capabilities';
import type { ProviderCallOptions } from './shared';
import type { SpokenAudioChunk } from '../media';

export const TtsVoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** BCP-47, or null when the backend does not say. */
  language: z.string().nullable(),
  /** Only what the backend reports; never inferred from the voice name. */
  gender: z.enum(['female', 'male', 'neutral', 'unknown']),
});
export type TtsVoice = z.infer<typeof TtsVoiceSchema>;

export const TtsRequestSchema = z.object({
  /** One sentence or clause out of the splitter, not a whole answer (P1-T04). */
  text: z.string().min(1),
  voiceId: z.string().min(1),
  speed: z.number().positive().max(4),
  /**
   * What the affect engine wants this line to sound like. Adapters whose backend has no
   * emotion control drop it; the capability flag says which ones those are.
   */
  hint: EmotionHintSchema.nullable(),
});
export type TtsRequest = z.infer<typeof TtsRequestSchema>;

/**
 * Text to speech. Yields audio as it is produced so the first sentence can start
 * playing while the rest of the answer is still being generated.
 */
export interface TTSProvider {
  readonly id: string;
  capabilities(): Promise<TtsCapabilities>;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(
    request: TtsRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<SpokenAudioChunk>;
}
