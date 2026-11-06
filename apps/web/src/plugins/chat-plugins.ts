import { PluginSession, askFirst, cryptoRandom, pluginTools, type EnabledPlugin, type PermissionPrompts, type PluginDisplay } from '@latentpresence/core';
import type { MemoryStore } from '@latentpresence/protocol';
import type { Settings } from '../settings/settings';
import { enabledPlugins, loadPlugin } from './manage';
import type { PluginShelf } from './shelf';

declare const APP_VERSION: string;

/**
 * The character's plugins for a visit to `/chat` (P10-T04, ADR-72): the ones turned on for them,
 * loaded directly unless the person chose "load only when needed" for one (ADR-72 item 4, as amended),
 * each checked again as it loads, its tools given the visit's memory store for their data, the
 * platform's randomness, the person's settings, and the gate for any tool that asks. Settings
 * changed in Settings → Plugins apply from the next visit, as the character switch does (ADR-55).
 */
export interface ChatPluginsOptions {
  readonly shelf: PluginShelf;
  readonly settings: Settings;
  readonly characterId: string;
  readonly store: MemoryStore;
  readonly prompts: PermissionPrompts;
  readonly show: (display: PluginDisplay) => void;
  readonly onProblem?: (id: string, problems: readonly string[]) => void;
  readonly appVersion?: string;
}

export async function loadChatPlugins(options: ChatPluginsOptions): Promise<PluginSession> {
  const enabled: EnabledPlugin[] = [];
  for (const id of enabledPlugins(options.settings, options.characterId)) {
    const loaded = await loadPlugin(options.shelf, id, options.appVersion ?? APP_VERSION);
    if (!loaded.ok) {
      options.onProblem?.(id, loaded.problems);
      continue;
    }
    const name = loaded.plugin.manifest.name;
    const host = { store: options.store, characterId: options.characterId, random: cryptoRandom, show: options.show, settings: options.settings.plugins[id] ?? {} };
    enabled.push({ plugin: loaded.plugin, tools: pluginTools(loaded.plugin, host).map((tool) => askFirst(tool, name, options.prompts)), always: !options.settings.lazyPlugins.includes(id) });
  }
  return new PluginSession(enabled);
}
