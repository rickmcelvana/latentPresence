import {
  CompanionErrorSchema,
  companionRoutes,
  type CancellationSignal,
  type JsonObject,
  type McpCallResult,
  type McpHostServer,
  type McpRequestOptions,
  type McpServerClient,
  type McpToolInfo,
} from '@latentpresence/protocol';
import type { HttpFetch } from '../llm/discovery';
import { normaliseBaseUrl } from '../llm/discovery';

/**
 * The companion's MCP servers as the page sees them (P5-T02, ADR-43): one `/mcp/tools` read
 * lists every server the companion's own `mcp.json` names, with its state, and the tools of the
 * ready ones; each ready server is an `McpServerClient` whose calls go through `/mcp/call`. The
 * gate, the naming and the transcript are core's, unchanged — a companion server is one more
 * client to `mcpTools`.
 */

export interface CompanionToolsOptions {
  /** The companion's origin — settings' `companionUrl`. */
  readonly baseUrl: string;
  readonly fetch?: HttpFetch | undefined;
  readonly signal?: CancellationSignal | undefined;
}

/** A server the companion reported, and — when it is ready — its tools and a client for them. */
export interface CompanionToolServer {
  readonly server: McpHostServer;
  readonly tools: readonly McpToolInfo[];
  readonly client: McpServerClient | null;
}

function abortSignal(signal: CancellationSignal | undefined): { signal?: AbortSignal } {
  if (signal === undefined) return {};
  if (signal instanceof AbortSignal) return { signal };
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort());
  return { signal: controller.signal };
}

async function request(fetchImpl: HttpFetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`the companion is not answering (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = CompanionErrorSchema.safeParse(json);
    throw new Error(failure.success ? failure.data.error.message : `the companion answered ${response.status}`);
  }
  return json;
}

class CompanionMcpClient implements McpServerClient {
  readonly serverName: string;
  readonly instructions: string | null;
  private readonly serverId: string;
  private readonly tools: readonly McpToolInfo[];
  private readonly baseUrl: string;
  private readonly fetchImpl: HttpFetch;

  constructor(server: McpHostServer, tools: readonly McpToolInfo[], baseUrl: string, fetchImpl: HttpFetch) {
    this.serverName = server.label;
    this.instructions = server.instructions;
    this.serverId = server.id;
    this.tools = tools;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  /** What the companion listed at load: its servers start once, and a change needs its restart (ADR-43). */
  async listTools(): Promise<McpToolInfo[]> {
    return [...this.tools];
  }

  async callTool(name: string, args: JsonObject, options: McpRequestOptions = {}): Promise<McpCallResult> {
    const route = companionRoutes.mcpCall;
    const body = { callId: crypto.randomUUID(), serverId: this.serverId, name, arguments: args };
    const json = await request(this.fetchImpl, `${this.baseUrl}${route.path}`, {
      method: route.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...abortSignal(options.signal),
    });
    const parsed = route.response.safeParse(json);
    if (!parsed.success) throw new Error('the companion answered in a shape this page does not know — it may be a different version');
    return parsed.data;
  }

  async close(): Promise<void> {
    // The companion owns the server; the page only stops calling it.
  }
}

/** Read `/mcp/tools`. Throws when the companion does not answer or answers in another shape. */
export async function companionToolServers(options: CompanionToolsOptions): Promise<CompanionToolServer[]> {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const route = companionRoutes.mcpTools;
  const json = await request(fetchImpl, `${baseUrl}${route.path}`, { method: route.method, ...abortSignal(options.signal) });
  const parsed = route.response.safeParse(json);
  if (!parsed.success) throw new Error('the companion answered in a shape this page does not know — it may be a different version');
  return parsed.data.servers.map((server) => {
    const tools = parsed.data.tools
      .filter((tool) => tool.serverId === server.id)
      .map(({ name, description, inputSchema, annotations }): McpToolInfo => ({ name, description, inputSchema, annotations }));
    return { server, tools, client: server.state === 'ready' ? new CompanionMcpClient(server, tools, baseUrl, fetchImpl) : null };
  });
}
