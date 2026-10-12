import type { LLMProvider, LlmStreamChunk } from '@latentpresence/protocol';

/**
 * Her thinking, taken off the answer as it streams (P6-T05, ADR-54).
 *
 * Ollama (0.34) streams a thinking model's reasoning in its own field, which the adapter turns
 * into `reasoning-delta` (measured 2026-10-12: glm-5.2, deepseek-r1:8b, qwen3.5:9b; nothing of
 * it in the content). Nothing that speaks or shows an answer reads `reasoning-delta`. A server
 * that does not split it writes `<think>…</think>` into the text instead, where the sentence
 * chunker would hand it to the voice; `withThinking` moves it to `reasoning-delta` first, so the
 * rule is one rule: reasoning is never text.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

/** The longest end of `text` that could be the start of `tag` (a tag split across deltas). */
function partialTag(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length -= 1) {
    if (tag.startsWith(text.slice(-length).toLowerCase())) return length;
  }
  return 0;
}

/** Splits `<think>…</think>` out of streamed text; a tag may arrive in pieces. */
export class InlineThinking {
  private held = '';
  private inside = false;

  push(delta: string): { readonly text: string; readonly reasoning: string } {
    let rest = this.held + delta;
    this.held = '';
    let text = '';
    let reasoning = '';
    for (;;) {
      const tag = this.inside ? CLOSE : OPEN;
      const at = rest.toLowerCase().indexOf(tag);
      if (at === -1) break;
      if (this.inside) reasoning += rest.slice(0, at);
      else text += rest.slice(0, at);
      rest = rest.slice(at + tag.length);
      this.inside = !this.inside;
    }
    const keep = partialTag(rest, this.inside ? CLOSE : OPEN);
    this.held = rest.slice(rest.length - keep);
    const out = rest.slice(0, rest.length - keep);
    if (this.inside) reasoning += out;
    else text += out;
    return { text, reasoning };
  }

  /** The end of the stream: anything held back is what it was. An unclosed think stays thinking. */
  flush(): { readonly text: string; readonly reasoning: string } {
    const held = this.held;
    this.held = '';
    return this.inside ? { text: '', reasoning: held } : { text: held, reasoning: '' };
  }
}

/**
 * `llm` with its reasoning handed to `onReasoning` as it arrives, and `<think>` text turned into
 * reasoning. Every chunk still flows: an answer is unchanged but for the thinking taken out of
 * its words.
 */
export function withThinking(llm: LLMProvider, onReasoning: (text: string) => void): LLMProvider {
  return {
    id: llm.id,
    listModels: () => llm.listModels(),
    async *stream(request, options): AsyncIterable<LlmStreamChunk> {
      const inline = new InlineThinking();
      const split = function* (part: { readonly text: string; readonly reasoning: string }): Generator<LlmStreamChunk> {
        if (part.reasoning !== '') {
          onReasoning(part.reasoning);
          yield { type: 'reasoning-delta', text: part.reasoning };
        }
        if (part.text !== '') yield { type: 'text-delta', text: part.text };
      };
      for await (const chunk of llm.stream(request, options)) {
        if (chunk.type === 'text-delta') {
          yield* split(inline.push(chunk.text));
          continue;
        }
        if (chunk.type === 'reasoning-delta' && chunk.text !== '') onReasoning(chunk.text);
        // What is held back of a split tag goes out before the answer ends or calls a tool.
        if (chunk.type === 'finish' || chunk.type === 'tool-call') yield* split(inline.flush());
        yield chunk;
      }
      yield* split(inline.flush());
    },
  };
}
