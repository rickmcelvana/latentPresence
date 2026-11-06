import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPlugin, type PluginCheck } from '@latentpresence/core';
import { diskFolder, fetchBytes, sha256Hex } from './folder';

export interface FolderCheckOptions {
  /** Download every asset at an address and check its bytes, as installing would. */
  readonly fetch?: boolean;
  readonly appVersion?: string;
}

/** `checkPlugin` over a folder on disk, with node's hashing and fetch. */
export async function checkFolder(dir: string, options: FolderCheckOptions = {}): Promise<PluginCheck> {
  let text: string;
  try {
    text = await readFile(join(dir, 'plugin.json'), 'utf8');
  } catch {
    return { ok: false, problems: [`There is no plugin.json in ${dir}.`] };
  }
  return checkPlugin(text, diskFolder(dir), {
    sha256: sha256Hex,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.fetch === true ? { fetchAsset: fetchBytes } : {}),
  });
}
