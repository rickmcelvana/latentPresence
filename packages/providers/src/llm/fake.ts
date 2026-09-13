import type { LLMProvider, LlmModel, LlmRequest, LlmStreamChunk, ProviderCallOptions } from '@latentpresence/protocol';

/** A scripted stream for tests: one chunk per script entry, in order. */
export type StreamScript = readonly LlmStreamChunk[];

export interface FakeLLMProviderOptions {
  /** Models `listModels()` returns; empty by default. */
  readonly models?: readonly LlmModel[];
  /** The stream each `stream()` call replays. */
  readonly script?: StreamScript;
  /**
   * Wait this long before each chunk, like a model generating. Needs a host `setTimeout`;
   * 0 (the default) replays with no timer at all.
   */
  readonly delayMs?: number;
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
  private readonly delayMs: number;
  /** How many chunks each `stream()` call yielded before it finished or was cancelled. */
  readonly yielded: number[] = [];

  constructor(id: string, options: FakeLLMProviderOptions = {}) {
    this.id = id;
    this.models = options.models ?? [];
    this.script = options.script ?? [];
    this.delayMs = options.delayMs ?? 0;
  }

  async listModels(): Promise<LlmModel[]> {
    return [...this.models];
  }

  /** Replays the script, and stops as soon as the call is cancelled — barge-in (P1-T08). */
  async *stream(_request: LlmRequest, options?: ProviderCallOptions): AsyncIterable<LlmStreamChunk> {
    const call = this.yielded.push(0) - 1;
    for (const chunk of this.script) {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (options?.signal?.aborted === true) return;
      this.yielded[call] = (this.yielded[call] ?? 0) + 1;
      yield chunk;
    }
  }
}
