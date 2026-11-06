import { checkPlugin, pluginBlockName, type CheckedPlugin } from '@latentpresence/core';
import type { MemoryStore } from '@latentpresence/protocol';
import type { Settings } from '../settings/settings';
import type { PluginAssets } from './assets';
import { pageSha256, type PluginInspection } from './inspect';
import type { InstalledPlugin, PluginShelf } from './shelf';
import { memoryFolder } from './sources';

declare const APP_VERSION: string;

/**
 * Installing, loading and removing a plugin (P10-T03, ADR-72 item 8). Installing keeps what the
 * consent screen showed, nothing more; removing takes away everything installing and using it
 * added, and its data only when the person says so.
 */

/** Keeps an inspected plugin. Called only after the person agreed to what `inspection.facts` showed. */
export async function installPlugin(inspection: Extract<PluginInspection, { ok: true }>, shelf: PluginShelf, now: Date = new Date()): Promise<InstalledPlugin> {
  const { manifest } = inspection.plugin;
  const installed: InstalledPlugin = { id: manifest.id, name: manifest.name, version: manifest.version, summary: manifest.summary, origin: inspection.source.origin, installedAt: now.toISOString() };
  await shelf.put(installed, { manifestText: inspection.source.manifestText, files: inspection.source.files });
  return installed;
}

export type LoadedPlugin =
  | { readonly ok: true; readonly plugin: CheckedPlugin; readonly files: ReadonlyMap<string, Uint8Array> }
  | { readonly ok: false; readonly problems: readonly string[] };

/** An installed plugin, checked again as it loads: what no longer passes (a newer app's rules, damaged storage) is not run. */
export async function loadPlugin(shelf: PluginShelf, id: string, appVersion: string = APP_VERSION): Promise<LoadedPlugin> {
  const stored = await shelf.read(id);
  if (stored === null) return { ok: false, problems: [`The plugin "${id}" is not installed.`] };
  const result = await checkPlugin(stored.manifestText, memoryFolder(stored.files), { sha256: pageSha256, appVersion });
  return result.ok ? { ok: true, plugin: result.plugin, files: stored.files } : result;
}

export interface RemovePluginOptions {
  readonly shelf: PluginShelf;
  readonly assets: PluginAssets;
  /** Given, its data is forgotten for each of these characters (ADR-72 item 5). */
  readonly forget?: { readonly store: MemoryStore; readonly characterIds: readonly string[]; readonly now?: () => Date };
}

/**
 * Removes the plugin and the pictures it downloaded; with `forget`, its data too. `MemoryStore`
 * cannot delete a block, so forgetting writes it empty, which the runtime reads as nothing kept.
 * The settings (enabled per character, its own values) are the caller's: `withoutPlugin`.
 */
export async function removePlugin(id: string, options: RemovePluginOptions): Promise<void> {
  const loaded = await loadPlugin(options.shelf, id);
  if (loaded.ok) await options.assets.forget(loaded.plugin);
  if (options.forget !== undefined) {
    const { store, characterIds } = options.forget;
    const at = (options.forget.now?.() ?? new Date()).toISOString();
    for (const characterId of characterIds) {
      const kept = (await store.readBlocks(characterId)).some((block) => block.name === pluginBlockName(id) && block.content !== '');
      if (kept) await store.writeBlock({ characterId, name: pluginBlockName(id), content: '', updatedAt: at, editableByCharacter: false });
    }
  }
  await options.shelf.remove(id);
}

// ── Settings ──────────────────────────────────────────────────────────────────

/** The plugins enabled for a character, in the order they were enabled. */
export function enabledPlugins(settings: Settings, characterId: string): readonly string[] {
  return settings.characters[characterId]?.plugins ?? [];
}

export function withPluginEnabled(settings: Settings, characterId: string, id: string, enabled: boolean): Settings {
  const current = settings.characters[characterId] ?? { voice: null, body: null, plugins: [] };
  const plugins = enabled ? [...current.plugins.filter((other) => other !== id), id] : current.plugins.filter((other) => other !== id);
  return { ...settings, characters: { ...settings.characters, [characterId]: { ...current, plugins } } };
}

export function withPluginSetting(settings: Settings, id: string, key: string, value: Settings['plugins'][string][string]): Settings {
  return { ...settings, plugins: { ...settings.plugins, [id]: { ...settings.plugins[id], [key]: value } } };
}

/** Whether a plugin loads only when she uses it (ADR-72 item 4, as amended); off, it loads directly. */
export function withPluginLazy(settings: Settings, id: string, lazy: boolean): Settings {
  const rest = settings.lazyPlugins.filter((other) => other !== id);
  return { ...settings, lazyPlugins: lazy ? [...rest, id] : rest };
}

/** Settings with no trace of the plugin: disabled for every character, its values gone. */
export function withoutPlugin(settings: Settings, id: string): Settings {
  const characters = Object.fromEntries(Object.entries(settings.characters).map(([characterId, character]) => [characterId, { ...character, plugins: character.plugins.filter((other) => other !== id) }]));
  const { [id]: _removed, ...plugins } = settings.plugins;
  return { ...settings, characters, plugins, lazyPlugins: settings.lazyPlugins.filter((other) => other !== id) };
}
