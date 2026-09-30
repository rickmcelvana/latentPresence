import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { JsonObjectSchema, JsonValueSchema, type CancellationSignal, type JsonObject, type McpCallResult, type McpRequestOptions, type McpServerClient, type McpToolInfo, type McpTransport } from '@latentpresence/protocol';

/**
 * An MCP server over `@ai-sdk/mcp` (P5-T01, ADR-42): streamable HTTP or SSE, from the page.
 *
 * **`listTools`/`callTool`, never `tools()`.** The AI SDK's tool objects carry their own
 * `execute` for its own loop; ours is `withLocalTools`, which gates, logs and runs every call,
 * so this adapter only lists and calls. Verified against DeepWiki 2026-09-30 (`docs/SURFACE.md`):
 * a server's failure — an unknown repository, an unknown tool — comes back as `isError`, not a
 * throw, and is passed on that way.
 */

export interface McpServerConfig {
  readonly url: string;
  readonly transport: McpTransport;
  /** Sent with every request: an `Authorization` header from the vault, say. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface ConnectMcpOptions {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: CancellationSignal | undefined;
}

/** The client wants a real `AbortSignal`; the protocol's `CancellationSignal` is its shape. */
function abortSignal(signal: CancellationSignal | undefined): { signal?: AbortSignal } {
  if (signal === undefined) return {};
  if (signal instanceof AbortSignal) return { signal };
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort());
  return { signal: controller.signal };
}

/** A content item as the server sent it; only the kinds this flattens are named. */
interface ContentItem {
  readonly type: string;
  readonly text?: unknown;
  readonly resource?: { readonly text?: unknown; readonly uri?: unknown };
  readonly uri?: unknown;
}

/** A call's result made into one `McpCallResult`: text joined, resources by their text or link, images counted. */
export function flattenCallResult(raw: unknown): McpCallResult {
  const result = (raw ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown; toolResult?: unknown };
  const content = Array.isArray(result.content) ? (result.content as ContentItem[]) : [];
  const parts: string[] = [];
  let images = 0;
  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'resource' && typeof item.resource?.text === 'string') parts.push(item.resource.text);
    else if (item.type === 'resource_link' && typeof item.uri === 'string') parts.push(`(link: ${item.uri})`);
    else if (item.type === 'image' || item.type === 'audio') images += 1;
  }
  // The older result shape: `toolResult` in place of `content`.
  if (content.length === 0 && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult));
  const structured = JsonValueSchema.safeParse(result.structuredContent);
  return { isError: result.isError === true, text: parts.join('\n\n'), structured: result.structuredContent === undefined || !structured.success ? null : structured.data, images };
}

function toolInfo(tool: { name: string; description?: string | undefined; inputSchema: unknown; annotations?: unknown }): McpToolInfo {
  const schema = JsonObjectSchema.safeParse(tool.inputSchema);
  const annotations = (tool.annotations ?? null) as McpToolInfo['annotations'];
  return { name: tool.name, description: tool.description ?? '', inputSchema: schema.success ? schema.data : { type: 'object' }, annotations };
}

class AiSdkMcpClient implements McpServerClient {
  readonly serverName: string;
  readonly instructions: string | null;
  private readonly client: MCPClient;

  constructor(client: MCPClient, fallbackName: string) {
    this.client = client;
    this.serverName = client.serverInfo?.name ?? fallbackName;
    this.instructions = client.instructions ?? null;
  }

  async listTools(options: McpRequestOptions = {}): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    // Paged: a server with many tools answers a page at a time. Ten pages is plenty for a person's list.
    for (let page = 0; page < 10; page += 1) {
      const listed = await this.client.listTools({ ...(cursor === undefined ? {} : { params: { cursor } }), options: abortSignal(options.signal) });
      tools.push(...listed.tools.map(toolInfo));
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  }

  async callTool(name: string, args: JsonObject, options: McpRequestOptions = {}): Promise<McpCallResult> {
    return flattenCallResult(await this.client.callTool({ name, arguments: args, options: abortSignal(options.signal) }));
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/** Connect and initialise. Throws when the server cannot be reached or refuses the handshake. */
export async function connectMcpServer(config: McpServerConfig, options: ConnectMcpOptions = {}): Promise<McpServerClient> {
  const fetchImpl = options.fetch;
  const client = await createMCPClient({
    transport: {
      type: config.transport,
      url: config.url,
      ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
      // Always a wrapper, never a bare `fetch`: the client calls it off its own object, and
      // `window.fetch` called that way throws "Illegal invocation" (Browser pane, 2026-09-30).
      fetch: (input: RequestInfo | URL, init?: RequestInit) => (fetchImpl ?? globalThis.fetch)(input, init),
    },
    clientName: 'latentPresence',
    ...(options.signal === undefined ? {} : { initializationOptions: abortSignal(options.signal) }),
  });
  let host = config.url;
  try {
    host = new URL(config.url).host;
  } catch {
    // Keep the URL as given.
  }
  return new AiSdkMcpClient(client, host);
}
