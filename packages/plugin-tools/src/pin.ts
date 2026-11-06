import type { PluginFolder } from '@latentpresence/core';

/**
 * Fills in each asset's `bytes` and `sha256` from the file or the address (`plugin:check --pin`).
 * Works on the raw JSON, before the schema, because a manifest being pinned for the first time
 * has no hashes yet and would not parse. Everything else in the file is left as it was.
 */
export async function pinAssets(
  raw: unknown,
  folder: PluginFolder,
  sha256: (bytes: Uint8Array) => Promise<string>,
  fetchAsset: (url: string) => Promise<Uint8Array>,
  concurrency = 6,
): Promise<{ readonly manifest: unknown; readonly pinned: number; readonly failed: readonly string[] }> {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { assets?: unknown }).assets)) return { manifest: raw, pinned: 0, failed: [] };
  const assets = (raw as { assets: unknown[] }).assets;
  const failed: string[] = [];
  let pinned = 0;
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const asset = assets[next] as Record<string, unknown>;
      next += 1;
      const id = String(asset['id'] ?? `#${next}`);
      try {
        let bytes: Uint8Array | null = null;
        if (typeof asset['path'] === 'string') bytes = await folder.bytes(asset['path']);
        else if (typeof asset['url'] === 'string') bytes = await fetchAsset(asset['url']);
        if (bytes === null) throw new Error('no file and no address to read');
        asset['bytes'] = bytes.length;
        asset['sha256'] = await sha256(bytes);
        pinned += 1;
      } catch (error) {
        failed.push(`Asset "${id}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, assets.length) }, worker));
  return { manifest: raw, pinned, failed };
}
