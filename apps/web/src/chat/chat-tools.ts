import type { ConnectedToolServer, ToolGrant, ToolGrants } from '@latentpresence/core';
import type { McpServerClient } from '@latentpresence/protocol';
import { connectMcpServer, type ConnectMcpOptions, type McpServerConfig } from '@latentpresence/providers/web';
import { loadSettings, mcpKeyRef, saveSettings, type Settings, type ToolServerSetting } from '../settings/settings';

/**
 * The page's side of MCP (P5-T01, ADR-42): connect the servers the person added, and keep their
 * decisions about tools in the settings document.
 */

export type ConnectMcp = (config: McpServerConfig, options?: ConnectMcpOptions) => Promise<McpServerClient>;

export interface ToolServerStatus {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  /** How many tools it listed, or why it could not be reached. */
  readonly detail: string;
}

export interface ConnectToolServersOptions {
  readonly servers: readonly ToolServerSetting[];
  /** A vault read: the bearer token of a server with `auth: 'bearer'`. */
  readonly loadKey: (ref: string) => Promise<string | null>;
  readonly connect?: ConnectMcp;
  readonly fetch?: typeof globalThis.fetch;
}

/** One server: connected and listed, or a status saying why not. Never throws. */
export async function connectToolServer(
  server: ToolServerSetting,
  options: Omit<ConnectToolServersOptions, 'servers'>,
): Promise<{ readonly connected: ConnectedToolServer | null; readonly status: ToolServerStatus }> {
  const connect = options.connect ?? connectMcpServer;
  try {
    const token = server.auth === 'bearer' ? await options.loadKey(mcpKeyRef(server.id)) : null;
    if (server.auth === 'bearer' && (token === null || token === '')) {
      return { connected: null, status: { id: server.id, label: server.label, ok: false, detail: 'It needs a token, and none is saved.' } };
    }
    const client = await connect(
      { url: server.url, transport: server.transport, ...(token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }) },
      options.fetch === undefined ? {} : { fetch: options.fetch },
    );
    const tools = await client.listTools();
    const count = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;
    return { connected: { id: server.id, label: server.label, client, tools }, status: { id: server.id, label: server.label, ok: true, detail: count } };
  } catch (error) {
    return { connected: null, status: { id: server.id, label: server.label, ok: false, detail: error instanceof Error ? error.message : String(error) } };
  }
}

/** Every enabled server, in parallel: one that fails offers no tools and says why. */
export async function connectToolServers(options: ConnectToolServersOptions): Promise<{ readonly connected: ConnectedToolServer[]; readonly statuses: ToolServerStatus[] }> {
  const results = await Promise.all(options.servers.filter((server) => server.enabled).map((server) => connectToolServer(server, options)));
  return { connected: results.flatMap((result) => (result.connected === null ? [] : [result.connected])), statuses: results.map((result) => result.status) };
}

/**
 * The person's tool decisions, read from and written to the settings document on every use —
 * so a change made in Settings in another tab applies at the next call, and "Always allow" in
 * `/chat` is there when Settings next opens.
 */
export function settingsToolGrants(storage: Pick<Storage, 'getItem' | 'setItem'>): ToolGrants {
  return {
    get(serverId, tool): ToolGrant | undefined {
      return loadSettings(storage).tools.grants[serverId]?.[tool];
    },
    set(serverId, tool, grant): void {
      const settings: Settings = loadSettings(storage);
      const grants = { ...settings.tools.grants, [serverId]: { ...settings.tools.grants[serverId], [tool]: grant } };
      saveSettings({ ...settings, tools: { ...settings.tools, grants } }, storage);
    },
  };
}
