import { checkPlugin, type CheckedPlugin } from '@latentpresence/core';
import { memoryFolder, type PluginOrigin, type PluginSource } from './sources';

declare const APP_VERSION: string;

/**
 * A plugin read and checked, and what the consent screen says about it (P10-T03, ADR-72 item 8).
 * The same `checkPlugin` an author runs as `pnpm plugin:check`, so the app refuses exactly what
 * the checker would have.
 */
export interface PluginConsentFacts {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly licence: string;
  readonly summary: string;
  readonly homepage: string | null;
  readonly origin: PluginOrigin;
  /** Every host it may contact: its assets' and its MCP servers' (and the address it came from). */
  readonly hosts: readonly string[];
  /** Bytes it may download as its pictures are first shown. */
  readonly downloadBytes: number;
  /** Bytes kept in this browser from the folder itself. */
  readonly keptBytes: number;
  /** Each asset licence and how many assets carry it. */
  readonly assetLicences: readonly { readonly licence: string; readonly count: number }[];
  readonly tools: readonly { readonly name: string; readonly description: string; readonly policy: 'auto' | 'ask' }[];
  readonly mcp: readonly { readonly name: string; readonly detail: string }[];
  readonly schedules: readonly { readonly description: string; readonly cron: string }[];
  /** Rough tokens: while enabled and unused, and once used (an estimate, said as one). */
  readonly promptTokens: { readonly idle: number; readonly used: number };
  readonly notes: readonly string[];
}

export type PluginInspection =
  | { readonly ok: true; readonly plugin: CheckedPlugin; readonly source: PluginSource; readonly facts: PluginConsentFacts }
  | { readonly ok: false; readonly problems: readonly string[] };

/** The page's SHA-256, or null outside a secure context (ADR-70: the size is still checked). */
export async function pageSha256(bytes: Uint8Array): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function inspectPlugin(source: PluginSource, appVersion: string = APP_VERSION): Promise<PluginInspection> {
  const result = await checkPlugin(source.manifestText, memoryFolder(source.files), { sha256: pageSha256, appVersion });
  if (!result.ok) return result;
  return { ok: true, plugin: result.plugin, source, facts: consentFacts(result.plugin, source, result.notes) };
}

export function consentFacts(plugin: CheckedPlugin, source: PluginSource, notes: readonly string[] = []): PluginConsentFacts {
  const { manifest } = plugin;
  const hosts = new Set<string>();
  if (source.origin.kind === 'url') hosts.add(new URL(source.origin.url).host);
  for (const asset of manifest.assets) if (asset.url !== undefined) hosts.add(new URL(asset.url).host);
  for (const server of manifest.mcp) if (server.transport === 'http') hosts.add(new URL(server.url).host);

  const licences = new Map<string, number>();
  for (const asset of manifest.assets) licences.set(asset.licence, (licences.get(asset.licence) ?? 0) + 1);
  const keptBytes = [...source.files.values()].reduce((sum, bytes) => sum + bytes.length, 0);

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    licence: manifest.licence,
    summary: manifest.summary,
    homepage: manifest.homepage ?? null,
    origin: source.origin,
    hosts: [...hosts].toSorted(),
    downloadBytes: manifest.assets.filter((asset) => asset.url !== undefined).reduce((sum, asset) => sum + asset.bytes, 0),
    keptBytes,
    assetLicences: [...licences].map(([licence, count]) => ({ licence, count })),
    tools: manifest.tools.map((tool) => ({ name: `${manifest.id}__${tool.name}`, description: tool.description, policy: tool.policy })),
    mcp: manifest.mcp.map((server) => ({ name: server.name, detail: server.transport === 'http' ? server.url : [server.command, ...server.args].join(' ') })),
    schedules: manifest.schedules.map((schedule) => ({ description: schedule.description, cron: schedule.cron })),
    promptTokens: plugin.promptTokens,
    notes,
  };
}
