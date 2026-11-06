import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { PluginFolder } from '@latentpresence/core';

/**
 * A plugin folder on disk (ADR-72). The manifest's schema already refuses `..` and absolute
 * paths; this refuses anything that resolves outside the folder anyway (a link, a case the
 * pattern missed), since a checker that can be pointed at `C:\` by a manifest is a file reader.
 */
export function diskFolder(root: string): PluginFolder {
  const base = resolve(root);
  const inside = (path: string): string | null => {
    const full = resolve(join(base, path));
    const rel = relative(base, full);
    return rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) ? null : full;
  };
  const read = async (path: string): Promise<Buffer | null> => {
    const full = inside(path);
    if (full === null) return null;
    try {
      return await readFile(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw error;
    }
  };
  return {
    bytes: async (path) => {
      const buffer = await read(path);
      return buffer === null ? null : new Uint8Array(buffer);
    },
    text: async (path) => (await read(path))?.toString('utf8') ?? null,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Downloads an asset as the app would: a plain GET, refused unless it answers 200. */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
