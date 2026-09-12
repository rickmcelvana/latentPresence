import type { LLMProvider, LlmModel, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';

/** A scripted stream for tests: one chunk per script entry, in order. */
export type StreamScript = readonly LlmStreamChunk[];

export interface FakeLLMProviderOptions {
  /** Models `listModels()` returns; empty by default. */
  readonly models?: readonly LlmModel[];
  /** The stream each `stream()` call replays. */
  readonly script?: StreamScript;
}

/**
 * A scripted `LLMProvider` (P1-T02). Every provider ships one so the conversation core
 * and settings UI can run without a live endpoint, and so a failing provider is a shape
 * test, not a network test. `listModels` returns the fixture models; `stream` replays
 * the script verbatim.
 */
export class FakeLLMProvider implements LLMProvider {
  readonly id: string;
  private readonly models: readonly LlmModel[];
  private readonly script: StreamScript;

  constructor(id: string, options: FakeLLMProviderOptions = {}) {
    this.id = id;
    this.models = options.models ?? [];
    this.script = options.script ?? [];
  }

  async listModels(): Promise<LlmModel[]> {
    return [...this.models];
  }

  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    for (const chunk of this.script) {
      yield chunk;
    }
  }
}
