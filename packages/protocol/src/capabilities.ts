import { z } from 'zod';

/**
 * What a provider can do, reported as data rather than discovered by trying. The
 * settings UI (P1-T10) renders a provider it has never heard of from these objects,
 * and the conversation core reads them to decide whether it has to fake something —
 * word timings, for instance, become wawa-lipsync analysis when the TTS has none.
 */

export const ProviderKindSchema = z.enum(['llm', 'stt', 'tts', 'embedding', 'omni', 'memory', 'avatar']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const LlmCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  toolCalls: z.boolean(),
  structuredOutput: z.boolean(),
  /** Reports a separate reasoning stream, like Ollama's thinking models. */
  thinking: z.boolean(),
  promptCaching: z.boolean(),
  vision: z.boolean(),
  /** null when the endpoint does not report a context length. */
  contextLength: z.number().int().positive().nullable(),
});
export type LlmCapabilities = z.infer<typeof LlmCapabilitiesSchema>;

export const SttCapabilitiesSchema = z.object({
  /** Emits partial results while the user is still talking. */
  streaming: z.boolean(),
  wordTimestamps: z.boolean(),
  languageDetection: z.boolean(),
  runsInBrowser: z.boolean(),
  /** BCP-47 tags the provider claims. Empty means it did not say. */
  languages: z.array(z.string()),
});
export type SttCapabilities = z.infer<typeof SttCapabilitiesSchema>;

export const TtsCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  wordTimestamps: z.boolean(),
  /** Takes an EmotionHint in some form: a style tag, instruct text, or a speed change. */
  emotionHints: z.boolean(),
  styleTags: z.boolean(),
  runsInBrowser: z.boolean(),
  sampleRate: z.number().int().positive(),
});
export type TtsCapabilities = z.infer<typeof TtsCapabilitiesSchema>;

export const EmbeddingCapabilitiesSchema = z.object({
  dimensions: z.number().int().positive(),
  maxBatch: z.number().int().positive(),
  /** True when vectors come back unit-length, so cosine distance needs no normalising. */
  normalized: z.boolean(),
  runsInBrowser: z.boolean(),
});
export type EmbeddingCapabilities = z.infer<typeof EmbeddingCapabilitiesSchema>;

export const OmniCapabilitiesSchema = z.object({
  audioIn: z.boolean(),
  audioOut: z.boolean(),
  textOut: z.boolean(),
  toolCalls: z.boolean(),
  streaming: z.boolean(),
});
export type OmniCapabilities = z.infer<typeof OmniCapabilitiesSchema>;

export const MemoryCapabilitiesSchema = z.object({
  vectorSearch: z.boolean(),
  /** Embedding dimension the store is configured for. Changing it forces a re-index. */
  dimensions: z.number().int().positive().nullable(),
  bitemporalFacts: z.boolean(),
  plans: z.boolean(),
  schedules: z.boolean(),
  /**
   * True when the store is across a network. The memory kernel batches harder and
   * caches more when this is set, because every retrieval pays a round trip (ADR-17).
   */
  remote: z.boolean(),
});
export type MemoryCapabilities = z.infer<typeof MemoryCapabilitiesSchema>;

export const AvatarCapabilitiesSchema = z.object({
  expressions: z.boolean(),
  visemes: z.boolean(),
  lookAt: z.boolean(),
  clips: z.boolean(),
  /** Direct bone access, which the procedural life layer needs (P2-T02). */
  boneAccess: z.boolean(),
});
export type AvatarCapabilities = z.infer<typeof AvatarCapabilitiesSchema>;

/**
 * A model the user would have to download before a provider can run. We ship no models
 * (ADR-09), so every browser-side provider declares what it would fetch and the consent
 * screen (P1-T13) shows exactly this before a single byte moves.
 */
export const ModelDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  licence: z.string().min(1),
  sourceUrl: z.url(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

const descriptorBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  /**
   * Weights this provider would download on first use. Empty for anything that talks to
   * a server the user already runs. A non-empty list means the consent screen comes first.
   */
  requiresDownload: z.array(ModelDescriptorSchema),
};

/**
 * A provider as the settings UI sees it, before anything is instantiated. The kind
 * decides which capability object comes with it.
 */
export const ProviderDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({ ...descriptorBase, kind: z.literal('llm'), capabilities: LlmCapabilitiesSchema }),
  z.object({ ...descriptorBase, kind: z.literal('stt'), capabilities: SttCapabilitiesSchema }),
  z.object({ ...descriptorBase, kind: z.literal('tts'), capabilities: TtsCapabilitiesSchema }),
  z.object({ ...descriptorBase, kind: z.literal('embedding'), capabilities: EmbeddingCapabilitiesSchema }),
  z.object({ ...descriptorBase, kind: z.literal('omni'), capabilities: OmniCapabilitiesSchema }),
  z.object({ ...descriptorBase, kind: z.literal('memory'), capabilities: MemoryCapabilitiesSchema }),
  z.object({ ...descriptorBase, kind: z.literal('avatar'), capabilities: AvatarCapabilitiesSchema }),
]);
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;
