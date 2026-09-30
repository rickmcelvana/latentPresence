import type { JsonObject, McpCallResult, McpRequestOptions, McpServerClient, McpToolInfo } from '@latentpresence/protocol';

export interface FakeMcpTool {
  readonly info: McpToolInfo;
  /** What a call returns; a throw is a broken connection, not a tool failure. */
  readonly run: (args: JsonObject) => McpCallResult | Promise<McpCallResult>;
}

/**
 * An `McpServerClient` in memory (P5-T01): the tools it was given, their calls recorded.
 * `tools` may be replaced to play a server whose tools change after they were trusted.
 */
export class FakeMcpServer implements McpServerClient {
  readonly serverName: string;
  readonly instructions: string | null;
  tools: FakeMcpTool[];
  readonly calls: { readonly name: string; readonly args: JsonObject }[] = [];
  closed = false;

  constructor(serverName: string, tools: FakeMcpTool[], instructions: string | null = null) {
    this.serverName = serverName;
    this.tools = tools;
    this.instructions = instructions;
  }

  async listTools(): Promise<McpToolInfo[]> {
    return this.tools.map((tool) => tool.info);
  }

  async callTool(name: string, args: JsonObject, options: McpRequestOptions = {}): Promise<McpCallResult> {
    if (options.signal?.aborted === true) throw new Error('aborted');
    this.calls.push({ name, args });
    const tool = this.tools.find((candidate) => candidate.info.name === name);
    if (tool === undefined) return { isError: true, text: `Unknown tool: ${name}`, structured: null, images: 0 };
    return tool.run(args);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A text result, the common case. */
export function textResult(text: string, isError = false): McpCallResult {
  return { isError, text, structured: null, images: 0 };
}
