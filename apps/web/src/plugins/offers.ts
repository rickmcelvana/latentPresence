import { mcpToolName, type ScheduleRequest } from '@latentpresence/core';
import { PLUGIN_APP_TOOLS, type PluginManifest, type PluginMcpServer, type PluginSchedulePreset } from '@latentpresence/protocol';
import type { Settings, ToolServerSetting } from '../settings/settings';

/**
 * What a plugin offers beyond its own tools (P10-T07, ADR-72 item 7): MCP servers and schedule
 * presets, **asked for once each, never added silently**. An HTTP server joins Settings → Tools,
 * tagged with the plugin; a stdio server is a program, so only the desktop shell adds it to the
 * companion's `mcp.json`, after showing the person the whole command in its own dialog; a schedule
 * is made for one character through the ordinary store. Each answer is kept in
 * `settings.pluginOffers`, and removing the plugin takes back everything it added.
 */

export type PluginOffer =
  | { readonly kind: 'http'; readonly key: string; readonly server: Extract<PluginMcpServer, { transport: 'http' }> }
  | { readonly kind: 'stdio'; readonly key: string; readonly server: Extract<PluginMcpServer, { transport: 'stdio' }> }
  | { readonly kind: 'schedule'; readonly key: string; readonly characterId: string; readonly preset: PluginSchedulePreset };

/** An answer: `added`, `declined`, or for a schedule the id it was made with. */
export type OfferAnswer = string;
export const DECLINED = 'declined';
export const ADDED = 'added';

const serverKey = (server: PluginMcpServer): string => `server:${server.id}`;
const scheduleKey = (characterId: string, preset: PluginSchedulePreset): string => `schedule:${characterId}:${preset.id}`;

/** Settings → Tools' id for a plugin's HTTP server: stable, and never one the person's servers use. */
export function pluginServerId(pluginId: string, serverId: string): string {
  return `plugin:${pluginId}:${serverId}`;
}

/** The name the companion gives a plugin's stdio server (its key in `mcp.json`, as the shell writes it). */
export function pluginStdioName(pluginId: string, serverId: string): string {
  return `${pluginId}-${serverId}`;
}

/**
 * Everything the plugin offers, for the characters it is on for: its servers once (they are shared,
 * like every MCP server), its schedules once per character. With the answer given, if any.
 */
export function pluginOffers(manifest: PluginManifest, settings: Settings, characterIds: readonly string[]): readonly { readonly offer: PluginOffer; readonly answer: OfferAnswer | null }[] {
  if (characterIds.length === 0) return [];
  const answers = settings.pluginOffers[manifest.id] ?? {};
  const servers = manifest.mcp.map((server): PluginOffer => (server.transport === 'http' ? { kind: 'http', key: serverKey(server), server } : { kind: 'stdio', key: serverKey(server), server }));
  const schedules = characterIds.flatMap((characterId) => manifest.schedules.map((preset): PluginOffer => ({ kind: 'schedule', key: scheduleKey(characterId, preset), characterId, preset })));
  return [...servers, ...schedules].map((offer) => ({ offer, answer: answers[offer.key] ?? null }));
}

export function withOfferAnswer(settings: Settings, pluginId: string, key: string, answer: OfferAnswer): Settings {
  return { ...settings, pluginOffers: { ...settings.pluginOffers, [pluginId]: { ...settings.pluginOffers[pluginId], [key]: answer } } };
}

/** The most servers Settings → Tools keeps (`ToolsSettingsSchema`). */
const MAX_SERVERS = 16;

/** Adds the plugin's HTTP server to Settings → Tools, on and tagged, and records the yes. Throws when the list is full. */
export function withHttpServer(settings: Settings, manifest: PluginManifest, server: Extract<PluginMcpServer, { transport: 'http' }>): Settings {
  const id = pluginServerId(manifest.id, server.id);
  const others = settings.tools.servers.filter((existing) => existing.id !== id);
  if (others.length >= MAX_SERVERS) throw new Error(`Settings → Tools already has ${MAX_SERVERS} servers, the most it keeps. Remove one first.`);
  const added: ToolServerSetting = { id, label: server.name, url: server.url, transport: 'http', enabled: true, auth: 'none', plugin: manifest.id };
  return withOfferAnswer({ ...settings, tools: { ...settings.tools, servers: [...others, added] } }, manifest.id, serverKey(server), ADDED);
}

/**
 * A preset as the schedule store takes it, in the person's zone: the plugin's own tools by the names
 * she has them under (`<plugin>__<tool>`), a server's as its page tools are named — Settings → Tools'
 * label for an HTTP one, the companion's name for a program.
 */
export function presetRequest(manifest: PluginManifest, preset: PluginSchedulePreset): ScheduleRequest {
  const tools = preset.tools.map((name) => {
    const at = name.indexOf('__');
    // Her own tools (ADR-73) by their own names; the plugin's own by the plugin's.
    if (at < 0) return PLUGIN_APP_TOOLS.includes(name) && !manifest.tools.some((tool) => tool.name === name) ? name : `${manifest.id}__${name}`;
    const server = manifest.mcp.find((candidate) => candidate.id === name.slice(0, at));
    const label = server === undefined ? name.slice(0, at) : server.transport === 'http' ? server.name : pluginStdioName(manifest.id, server.id);
    return mcpToolName(label, name.slice(at + 2));
  });
  const task = preset.taskPrompt.trim();
  return { description: preset.description, repeat: preset.cron, ...(task === '' ? {} : { task, tools }), delivery: preset.delivery, catchUp: preset.catchUp };
}

/** What removing the plugin must take back, read from settings before they forget it. */
export interface PluginAdditions {
  /** Schedules it made, by character. */
  readonly schedules: readonly { readonly characterId: string; readonly scheduleId: string }[];
  /** Whether a program of its was added to the companion. */
  readonly programs: boolean;
}

export function pluginAdditions(settings: Settings, manifest: PluginManifest | null, pluginId: string): PluginAdditions {
  const answers = settings.pluginOffers[pluginId] ?? {};
  const schedules = Object.entries(answers).flatMap(([key, answer]) => {
    const match = /^schedule:([^:]+):[^:]+$/u.exec(key);
    return match?.[1] === undefined || answer === DECLINED ? [] : [{ characterId: match[1], scheduleId: answer }];
  });
  // Without its manifest (damaged storage), ask the shell anyway when any server was added: it removes only tagged entries.
  const stdioIds = manifest === null ? null : new Set(manifest.mcp.filter((server) => server.transport === 'stdio').map((server) => serverKey(server)));
  const programs = Object.entries(answers).some(([key, answer]) => answer === ADDED && key.startsWith('server:') && (stdioIds === null || stdioIds.has(key)));
  return { schedules, programs };
}

/** Settings with the plugin's servers and their grants gone, and its answers forgotten. */
export function withoutPluginOffers(settings: Settings, pluginId: string): Settings {
  const removed = new Set(settings.tools.servers.filter((server) => server.plugin === pluginId).map((server) => server.id));
  const grants = Object.fromEntries(Object.entries(settings.tools.grants).filter(([serverId]) => !removed.has(serverId) && !serverId.startsWith(`companion:${pluginId}-`)));
  const { [pluginId]: _forgotten, ...remaining } = settings.pluginOffers;
  return { ...settings, tools: { ...settings.tools, servers: settings.tools.servers.filter((server) => !removed.has(server.id)), grants }, pluginOffers: remaining };
}

/** Which plugin made each schedule, for the Schedules panel's tag. */
export function scheduleOwners(settings: Settings): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const [pluginId, answers] of Object.entries(settings.pluginOffers)) {
    for (const [key, answer] of Object.entries(answers)) if (key.startsWith('schedule:') && answer !== DECLINED) owners.set(answer, pluginId);
  }
  return owners;
}
