import type { JsonObject, JsonValue, McpServerClient, McpToolInfo, ToolCall, ToolResult } from '@latentpresence/protocol';
import type { LocalTool } from '../self/tools';
import { effectivePolicy, toolFingerprint, type PermissionPrompts, type ToolGrants } from './gate';

/**
 * MCP tools as page tools (P5-T01, ADR-42): every tool of every connected server becomes a
 * `LocalTool` that `withLocalTools` offers and runs like her notes — through the gate first.
 *
 * **Named `<server>__<tool>`**: two servers may both have `search`, and the model must be able
 * to tell them apart; OpenAI-compatible names allow `[a-zA-Z0-9_-]{1,64}`, nothing else.
 */

/** A server the page connected to, with the tools it listed. */
export interface ConnectedToolServer {
  /** The person's id for it, stable across renames: where its grants are kept. */
  readonly id: string;
  /** The person's name for it, shown in prompts and the transcript. */
  readonly label: string;
  readonly client: McpServerClient;
  readonly tools: readonly McpToolInfo[];
}

/** How much of a result the model reads: a page of text, not a book. */
export const MCP_RESULT_LIMIT = 8000;
const NAME_LIMIT = 64;
const SEPARATOR = '__';

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '');
  return cleaned === '' ? 'server' : cleaned;
}

/** `DeepWiki` + `read_wiki_structure` → `deepwiki__read_wiki_structure`, within 64 characters. */
export function mcpToolName(label: string, tool: string): string {
  const server = slug(label).slice(0, 20);
  const name = tool.replaceAll(/[^a-zA-Z0-9_-]/gu, '_');
  return `${server}${SEPARATOR}${name}`.slice(0, NAME_LIMIT);
}

/** The other way, for display: `deepwiki__read_wiki_structure` → DeepWiki's slug and the tool. */
export function splitToolName(name: string): { readonly server: string | null; readonly tool: string } {
  const at = name.indexOf(SEPARATOR);
  return at <= 0 ? { server: null, tool: name } : { server: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) };
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more characters cut]`;
}

export interface McpToolsOptions {
  readonly grants: ToolGrants;
  readonly prompts: PermissionPrompts;
  readonly limit?: number;
}

/** The page tools for these servers; `never` tools are not offered at all. */
export function mcpTools(servers: readonly ConnectedToolServer[], options: McpToolsOptions): LocalTool[] {
  const limit = options.limit ?? MCP_RESULT_LIMIT;
  const taken = new Set<string>();
  const tools: LocalTool[] = [];
  for (const server of servers) {
    for (const info of server.tools) {
      if (effectivePolicy(options.grants.get(server.id, info.name), info).policy === 'never') continue;
      let name = mcpToolName(server.label, info.name);
      for (let n = 2; taken.has(name); n += 1) name = `${mcpToolName(server.label, info.name).slice(0, NAME_LIMIT - 3)}_${n}`;
      taken.add(name);
      tools.push({
        definition: {
          name,
          description: `(From ${server.label}, outside this computer.) ${info.description}`.trim(),
          parameters: { type: 'object', ...info.inputSchema },
        },
        async run(args, context): Promise<JsonValue> {
          // Read again at the call: the person may have changed it since the request was built.
          const { policy, changed } = effectivePolicy(options.grants.get(server.id, info.name), info);
          if (policy === 'never') return { error: `The person does not allow ${server.label}'s ${info.name}.` };
          if (policy === 'ask') {
            const outcome = await options.prompts.ask(
              { serverId: server.id, serverName: server.label, tool: info.name, description: info.description, args: args as JsonObject, changed },
              context.signal,
            );
            if (outcome.decision === 'deny') {
              if ('reason' in outcome && outcome.reason === 'timeout') return { error: `They did not answer whether you may use ${server.label}'s ${info.name}, so it did not run. Carry on without it.` };
              if ('reason' in outcome && outcome.reason === 'stopped') return { error: 'Stopped before it ran.' };
              return { error: `The person you are talking to said no to using ${server.label}. Use none of its tools for this. Speaking to them, say in your own words that you will leave it since they would rather you did not, then help from what you know.` };
            }
            if (outcome.decision === 'always') options.grants.set(server.id, info.name, { policy: 'auto', fingerprint: toolFingerprint(info) });
          }
          let result;
          try {
            result = await server.client.callTool(info.name, args as JsonObject, { signal: context.signal });
          } catch (error) {
            return { error: `${server.label} could not be reached: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (result.isError) return { error: `${server.label} said: ${cut(result.text, 1000) || 'the tool failed'}` };
          const structured = result.structured === null ? null : JSON.stringify(result.structured);
          const body: JsonValue = structured !== null && structured.length <= limit ? result.structured : cut(result.text || (structured ?? ''), limit);
          return { from: server.label, result: body, ...(result.images > 0 ? { note: `${result.images} image(s) left out; you cannot see them.` } : {}) };
        },
      });
    }
  }
  return tools;
}

/** A page tool's result as the protocol's `ToolResult`, for the transcript: an `{ error }` is a failure. */
export function toolResultOf(call: ToolCall, value: JsonValue, at: string): ToolResult {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value['error'] === 'string') {
    return { ok: false, callId: call.id, error: value['error'] || 'failed', finishedAt: at };
  }
  return { ok: true, callId: call.id, value, finishedAt: at };
}
