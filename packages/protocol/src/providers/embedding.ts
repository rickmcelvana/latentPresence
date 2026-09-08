import { z } from 'zod';
import type { EmbeddingCapabilities } from '../capabilities';
import type { ProviderCallOptions } from './shared';

/** A single vector. Length must match the store's configured dimensions. */
export const EmbeddingVectorSchema = z.array(z.number()).min(1);
export type EmbeddingVector = z.infer<typeof EmbeddingVectorSchema>;

/**
 * Text to vectors. Batched because both the network round trip and the model call cost
 * far more per request than per item, and ingestion embeds thousands of chunks.
 */
export interface EmbeddingProvider {
  readonly id: string;
  capabilities(): Promise<EmbeddingCapabilities>;
  /** One vector per input, in order. Callers chunk to `maxBatch` themselves. */
  embed(texts: readonly string[], options?: ProviderCallOptions): Promise<EmbeddingVector[]>;
}
