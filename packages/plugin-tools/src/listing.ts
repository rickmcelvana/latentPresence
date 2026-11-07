import { checkPlugin, type PluginFolder } from '@latentpresence/core';
import { PluginIndexEntrySchema, type PluginIndex, type PluginIndexEntry } from '@latentpresence/protocol';

/**
 * A plugin's entry in the index (ADR-72 item 9, P10-T09): what Browse shows, the manifest's address
 * and the SHA-256 of the manifest and of every other file of the folder it names, so a plugin
 * changed after listing is refused. Checked as installing checks it first: a plugin that would be
 * refused is never listed.
 */
export async function indexEntry(folder: PluginFolder, manifestUrl: string, sha256: (bytes: Uint8Array) => Promise<string>, tags: readonly string[] = []): Promise<PluginIndexEntry> {
  const manifestBytes = await folder.bytes('plugin.json');
  if (manifestBytes === null) throw new Error('There is no plugin.json.');
  const checked = await checkPlugin(new TextDecoder().decode(manifestBytes), folder, { sha256 });
  if (!checked.ok) throw new Error(`It is not a valid plugin:\n  - ${checked.problems.join('\n  - ')}`);
  const { manifest } = checked.plugin;
  const paths = [manifest.instructions, ...Object.values(manifest.data), ...manifest.assets.flatMap((asset) => (asset.path === undefined ? [] : [asset.path]))];
  const files: Record<string, string> = {};
  for (const path of [...new Set(paths)].toSorted()) {
    const bytes = await folder.bytes(path);
    if (bytes === null) throw new Error(`${path} is named in plugin.json but missing.`);
    files[path] = await sha256(bytes);
  }
  return PluginIndexEntrySchema.parse({
    id: manifest.id,
    name: manifest.name,
    summary: manifest.summary,
    author: manifest.author,
    version: manifest.version,
    licence: manifest.licence,
    tags,
    manifest: manifestUrl,
    sha256: await sha256(manifestBytes),
    files,
  });
}

/** The index with these entries in, replacing any of the same id; the rest kept, sorted by id. */
export function withEntries(index: PluginIndex | null, entries: readonly PluginIndexEntry[]): PluginIndex {
  const kept = (index?.plugins ?? []).filter((plugin) => !entries.some((entry) => entry.id === plugin.id));
  return {
    $schema: './plugin-index.schema.json',
    format: 1,
    plugins: [...kept, ...entries].toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}
