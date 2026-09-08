import type { OmniCapabilities } from '../capabilities';
import type { ToolCall } from '../conversation';
import type { AudioChunk, SpokenAudioChunk } from '../media';
import type { LlmFinishReason, LlmRequest } from './llm';
import type { ProviderCallOptions } from './shared';

/**
 * A piece of an omni model's answer.
 *
 * This one is a TypeScript union rather than a zod schema, on purpose: an `audio`
 * variant carries PCM, so the union never crosses a boundary as a whole and parsing it
 * would mean parsing sample buffers. The serialisable parts are already schemas.
 */
export type OmniChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'audio'; readonly chunk: SpokenAudioChunk }
  | { readonly type: 'tool-call'; readonly call: ToolCall }
  | { readonly type: 'finish'; readonly reason: LlmFinishReason };

/**
 * Audio in, audio and text out: Qwen3-Omni and its kind, which hear tone directly
 * instead of being told about it. The optional path; the cascaded pipeline stays the
 * default because it works with any text model (ADR-06).
 */
export interface OmniProvider {
  readonly id: string;
  capabilities(): Promise<OmniCapabilities>;
  /**
   * `context` carries the same messages and tools a text model would get, minus the
   * current user turn, which arrives as audio.
   */
  converse(
    audio: AsyncIterable<AudioChunk>,
    context: LlmRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<OmniChunk>;
}
