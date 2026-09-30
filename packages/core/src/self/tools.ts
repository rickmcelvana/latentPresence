import type { JsonValue, LLMProvider, LlmMessage, LlmRequest, LlmStreamChunk, LlmTool, ProviderCallOptions, ToolCall } from '@latentpresence/protocol';
import { z } from 'zod';
import type { SelfNotes } from './notes';

/**
 * Tools the page runs itself (P4-T06, ADR-40), and the one place they are run.
 *
 * **A provider, not a session feature.** `withLocalTools` wraps an `LLMProvider`: it adds the
 * tools to every request, and when the model calls one it runs it, hands back the result and
 * streams the model's continuation — so the typed path, the spoken reply and the voice call,
 * which all call `llm.stream`, get the tools without one of them changing. Text before and
 * after the call streams straight through; only the tool round trip is added, and only when
 * the model chooses to use one.
 *
 * Local tools only: MCP servers, permissions and the tool log are P5-T01's. The character's
 * own notes need none of that — they are hers, and they change nothing outside her.
 */

export interface LocalTool {
  readonly definition: LlmTool;
  /** The result the model reads. A refusal is a result too (a sentence), never a throw. */
  run(args: Readonly<Record<string, JsonValue>>): Promise<JsonValue>;
}

export interface LocalToolsOptions {
  /** How many tool rounds one answer may take before the model is asked to just answer. */
  readonly maxRounds?: number;
  /** Every call and what it returned, for a log or a test. */
  readonly onCall?: (call: ToolCall, result: JsonValue) => void;
}

export const DEFAULT_TOOL_ROUNDS = 2;

async function runCall(tools: readonly LocalTool[], call: ToolCall): Promise<JsonValue> {
  const tool = tools.find((candidate) => candidate.definition.name === call.name);
  if (tool === undefined) return { error: `There is no tool called ${call.name}.` };
  try {
    return await tool.run(call.arguments);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `llm` with `tools()` offered on every request and run when called. `tools` is read per
 * request, so a page can wrap its provider before the tools exist (the store is chosen after
 * the page mounts) and an empty list is exactly the unwrapped provider.
 */
export function withLocalTools(llm: LLMProvider, tools: () => readonly LocalTool[], options: LocalToolsOptions = {}): LLMProvider {
  const maxRounds = options.maxRounds ?? DEFAULT_TOOL_ROUNDS;
  return {
    id: llm.id,
    listModels: () => llm.listModels(),
    async *stream(request: LlmRequest, callOptions?: ProviderCallOptions): AsyncIterable<LlmStreamChunk> {
      const local = tools();
      if (local.length === 0) {
        yield* llm.stream(request, callOptions);
        return;
      }
      let messages: LlmMessage[] = request.messages;
      // What was said before a tool call and what is said after it are two answers to the
      // model and one to the person: "together." then "So I've…" must not arrive as
      // "together.So I've…" (seen live, P4-T07). A space goes between them when neither has one.
      let spoken = '';
      for (let round = 0; ; round += 1) {
        // The last round offers no local tools, so an answer always ends in words.
        const offered = round < maxRounds ? local : [];
        const calls: ToolCall[] = [];
        let text = '';
        let finish: LlmStreamChunk | null = null;
        for await (const chunk of llm.stream({ ...request, messages, tools: [...request.tools, ...offered.map((tool) => tool.definition)] }, callOptions)) {
          if (chunk.type === 'tool-call' && offered.some((tool) => tool.definition.name === chunk.call.name)) {
            calls.push(chunk.call);
          } else if (chunk.type === 'finish') {
            finish = chunk;
          } else if (chunk.type === 'text-delta') {
            const joined = text === '' && spoken !== '' && !/\s$/u.test(spoken) && !/^\s/u.test(chunk.text) ? ` ${chunk.text}` : chunk.text;
            text += chunk.text;
            spoken += joined;
            yield joined === chunk.text ? chunk : { ...chunk, text: joined };
          } else {
            yield chunk;
          }
        }
        if (calls.length === 0 || callOptions?.signal?.aborted === true) {
          if (finish !== null) yield finish;
          return;
        }
        const results = await Promise.all(calls.map((call) => runCall(local, call)));
        for (const [i, call] of calls.entries()) options.onCall?.(call, results[i] ?? null);
        messages = [
          ...messages,
          { role: 'assistant', content: text, toolCalls: calls },
          ...calls.map((call, i): LlmMessage => ({ role: 'tool', callId: call.id, content: results[i] ?? null })),
        ];
      }
    },
  };
}

const ReadArgs = z.object({ name: z.string() });
const WriteArgs = z.object({ name: z.string(), content: z.string() });

/**
 * `self_read_block` and `self_write_block` (the plan's `self.read_block`/`self.write_block`,
 * with underscores: OpenAI-compatible function names allow no dots).
 */
export function selfNoteTools(notes: SelfNotes): LocalTool[] {
  return [
    {
      definition: {
        name: 'self_read_block',
        description: 'Read one of your own notes by name. Your notes are also in your instructions; use this to check one exactly.',
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'The note to read.' } }, required: ['name'] },
      },
      async run(args) {
        const parsed = ReadArgs.safeParse(args);
        if (!parsed.success) return { error: 'Give the name of the note to read.' };
        await notes.load();
        const note = notes.notes().find((candidate) => candidate.name === parsed.data.name);
        return note === undefined ? { error: `You have no note called "${parsed.data.name}".`, notes: notes.notes().map((candidate) => candidate.name) } : { name: note.name, content: note.content };
      },
    },
    {
      definition: {
        name: 'self_write_block',
        description:
          'Write one of your own notes, replacing what it said: something you have come to understand about yourself or about the person you talk to, in your own words. ' +
          'Keep a few short notes rather than many. Facts they tell you are remembered for you; use notes for what you make of them.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A short lowercase name, words joined by underscores, like how_they_like_to_talk.' },
            content: { type: 'string', description: 'The whole note, as it should now read.' },
          },
          required: ['name', 'content'],
        },
      },
      async run(args) {
        const parsed = WriteArgs.safeParse(args);
        if (!parsed.success) return { error: 'Give a name and the whole content of the note.' };
        const outcome = await notes.writeNote(parsed.data.name.trim(), parsed.data.content.trim());
        return outcome.ok ? { saved: parsed.data.name.trim() } : { error: outcome.reason };
      },
    },
  ];
}
