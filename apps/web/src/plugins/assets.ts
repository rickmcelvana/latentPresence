import type { CheckedPlugin } from '@latentpresence/core';
import { pageSha256 } from './inspect';
import { unreachable } from './sources';

/**
 * A plugin's pictures (P10-T03, ADR-72 items 6 and 8). An asset in the folder was kept at install;
 * one at an address downloads the first time it is shown, is checked against the size and SHA-256
 * in the manifest (ADR-70), and is kept in a cache of its own, `latentpresence-plugin-assets`, so
 * removing a plugin can remove exactly its files. Only checked bytes are kept, and a kept file that
 * no longer checks is dropped and fetched again.
 */
export const PLUGIN_ASSET_CACHE = 'latentpresence-plugin-assets';

export interface AssetCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
}

export interface PluginAssetsDeps {
  readonly fetch: typeof fetch;
  /** Null where Cache Storage is missing or refused (a private window): every use downloads again. */
  readonly cache: () => Promise<AssetCache | null>;
}

function realDeps(): PluginAssetsDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    cache: async () => {
      try {
        return (await (globalThis as { caches?: CacheStorage }).caches?.open(PLUGIN_ASSET_CACHE)) ?? null;
      } catch {
        return null;
      }
    },
  };
}

export class AssetProblem extends Error {}

export class PluginAssets {
  private readonly deps: PluginAssetsDeps;

  constructor(deps: PluginAssetsDeps = realDeps()) {
    this.deps = deps;
  }

  /** The asset's bytes as a blob of its type, for an image to show. */
  async blob(plugin: CheckedPlugin, files: ReadonlyMap<string, Uint8Array>, assetId: string): Promise<Blob> {
    const asset = plugin.manifest.assets.find((candidate) => candidate.id === assetId);
    if (asset === undefined) throw new AssetProblem(`${plugin.manifest.name} has no picture "${assetId}".`);
    const label = `${plugin.manifest.name}'s "${asset.id}"`;
    let bytes: Uint8Array;
    if (asset.path !== undefined) {
      const kept = files.get(asset.path);
      if (kept === undefined) throw new AssetProblem(`${label} is missing from the installed plugin; install it again.`);
      bytes = kept;
    } else {
      bytes = await this.downloaded(asset.url ?? '', asset.bytes, asset.sha256, label);
    }
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: asset.type });
  }

  /** Removes every file this plugin downloaded. */
  async forget(plugin: CheckedPlugin): Promise<void> {
    const cache = await this.deps.cache();
    if (cache === null) return;
    for (const asset of plugin.manifest.assets) {
      if (asset.url === undefined) continue;
      try {
        await cache.delete(asset.url);
      } catch {
        // Nothing to remove from a cache that cannot be read.
      }
    }
  }

  private async downloaded(url: string, size: number, sha256: string, label: string): Promise<Uint8Array> {
    const cache = await this.deps.cache();
    if (cache !== null) {
      try {
        const kept = await cache.match(url);
        if (kept !== undefined) {
          const bytes = new Uint8Array(await kept.arrayBuffer());
          if ((await problem(bytes, size, sha256, label)) === null) return bytes;
          await cache.delete(url);
        }
      } catch {
        // Falls through to a download.
      }
    }
    let response: Response;
    try {
      response = await this.deps.fetch(url);
    } catch {
      throw new AssetProblem(unreachable(new URL(url)));
    }
    if (!response.ok) throw new AssetProblem(`${label}: ${new URL(url).host} answered ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const wrong = await problem(bytes, size, sha256, label);
    if (wrong !== null) throw new AssetProblem(wrong);
    if (cache !== null) {
      try {
        await cache.put(url, new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream' } }));
      } catch {
        // Checked bytes in hand; a cache that cannot be written means the next use downloads again.
      }
    }
    return bytes;
  }
}

async function problem(bytes: Uint8Array, size: number, sha256: string, label: string): Promise<string | null> {
  if (bytes.length !== size) return `${label}: downloaded ${bytes.length} bytes, and the plugin says ${size}. It was not kept.`;
  const actual = await pageSha256(bytes);
  if (actual !== null && actual !== sha256) return `${label}: these are not the bytes the plugin pinned (SHA-256 ${actual}, expected ${sha256}). It was not kept.`;
  return null;
}
