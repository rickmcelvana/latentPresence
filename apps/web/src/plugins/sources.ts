import type { PluginFolder } from '@latentpresence/core';
import type { PluginIndexEntry } from '@latentpresence/protocol';
import { readZip } from './zip';

/**
 * Where a plugin comes from before it is installed (P10-T03, ADR-72 item 8): a folder the person
 * picked, a zip, or the address of a `plugin.json`. Each becomes the same thing: the manifest's
 * text and the folder's files by path. Assets at an address are not fetched here: they download
 * when first shown, inside the size the consent screen stated.
 */
export interface PluginSource {
  readonly manifestText: string;
  /** The folder's files by their path inside it (`data/cards.json`). */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly origin: PluginOrigin;
}

export type PluginOrigin =
  | { readonly kind: 'folder'; readonly name: string }
  | { readonly kind: 'zip'; readonly name: string }
  /** `listed`: from the index, every file matching the hash it was listed with (ADR-72 item 9). */
  | { readonly kind: 'url'; readonly url: string; readonly listed: boolean };

export class SourceProblem extends Error {
  /** The HTTP status, when a server answered with one. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** A folder's files in a map, for `checkPlugin` and the runtime. */
export function memoryFolder(files: ReadonlyMap<string, Uint8Array>): PluginFolder {
  return {
    bytes: async (path) => files.get(path) ?? null,
    text: async (path) => {
      const bytes = files.get(path);
      return bytes === undefined ? null : new TextDecoder().decode(bytes);
    },
  };
}

/**
 * Files named by their path from wherever the picker or the zip starts. The plugin is wherever
 * `plugin.json` is, at the top or one folder down (a zip of the folder, a picked parent):
 * everything is re-rooted there, and anything outside it left behind.
 */
export function rootAtManifest(entries: Iterable<readonly [string, Uint8Array]>, origin: PluginOrigin): PluginSource {
  const all = [...entries].map(([path, bytes]) => [path.replaceAll('\\', '/').replace(/^\/+/, ''), bytes] as const);
  const manifests = all.filter(([path]) => path === 'plugin.json' || /^[^/]+\/plugin\.json$/.test(path)).toSorted(([a], [b]) => a.length - b.length);
  const manifest = manifests[0];
  if (manifest === undefined) throw new SourceProblem('There is no plugin.json at the top of it, or one folder down.');
  if (manifests.length > 1 && manifests[1]?.[0].length === manifest[0].length) throw new SourceProblem('It holds more than one plugin; pick one plugin\'s folder.');
  const prefix = manifest[0].slice(0, -'plugin.json'.length);
  const files = new Map(all.filter(([path]) => path.startsWith(prefix) && path !== manifest[0]).map(([path, bytes]) => [path.slice(prefix.length), bytes]));
  return { manifestText: new TextDecoder().decode(manifest[1]), files, origin };
}

/** What a folder picker (`<input webkitdirectory>`) or a drop gives: each file with its path. */
export interface PickedFile {
  readonly path: string;
  bytes(): Promise<Uint8Array>;
}

/** The folder picker's files; `webkitRelativePath` starts with the picked folder's own name. */
export async function sourceFromFolder(picked: readonly PickedFile[]): Promise<PluginSource> {
  if (picked.length === 0) throw new SourceProblem('The folder is empty.');
  const first = picked[0]?.path.split('/')[0] ?? 'plugin';
  const entries = await Promise.all(picked.map(async (file) => [file.path.split('/').slice(1).join('/') || file.path, await file.bytes()] as const));
  return rootAtManifest(entries, { kind: 'folder', name: first });
}

export async function sourceFromZip(name: string, bytes: Uint8Array): Promise<PluginSource> {
  return rootAtManifest(await readZip(bytes), { kind: 'zip', name });
}

/**
 * A `plugin.json` at an address, and the files it names beside it: the instructions, the data and
 * any asset kept in the folder. The address must send CORS, as raw GitHub files do. What the
 * manifest names is read loosely here; `checkPlugin` says what is wrong with it afterwards.
 */
export async function sourceFromUrl(address: string, fetcher: typeof fetch, listing?: Listing): Promise<PluginSource> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new SourceProblem(`"${address}" is not a web address.`);
  }
  if (url.protocol !== 'https:') throw new SourceProblem('A plugin\'s address must start with https://.');
  const manifestBytes = await downloadBytes(url, fetcher);
  if (listing !== undefined) await checkListed(listing, 'plugin.json', manifestBytes, listing.entry.sha256);
  const manifestText = new TextDecoder().decode(manifestBytes);
  if (listing !== undefined && manifestId(manifestText) !== listing.entry.id) throw new SourceProblem(`${listing.entry.name} is listed as "${listing.entry.id}", but its plugin.json says otherwise.`);
  const named = namedFiles(manifestText);
  const files = new Map<string, Uint8Array>();
  for (const path of named) {
    // A path the schema will refuse is not fetched: `..` must never climb out of the plugin's folder on a server either.
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(path)) continue;
    const pinned = listing?.entry.files[path];
    if (listing !== undefined && pinned === undefined) throw new SourceProblem(changed(listing, path));
    try {
      const bytes = await downloadBytes(new URL(path, url), fetcher);
      if (listing !== undefined && pinned !== undefined) await checkListed(listing, path, bytes, pinned);
      files.set(path, bytes);
    } catch (error) {
      if (!(error instanceof SourceProblem && error.status === 404)) throw error;
      // Missing: `checkPlugin` names it.
    }
  }
  return { manifestText, files, origin: { kind: 'url', url: url.href, listed: listing !== undefined } };
}

/**
 * A plugin installed from the index (ADR-72 item 9): its entry, whose hashes every file must match,
 * and the page's SHA-256 (`null` outside a secure context, where nothing can be checked).
 */
export interface Listing {
  readonly entry: PluginIndexEntry;
  readonly sha256: (bytes: Uint8Array) => Promise<string | null>;
}

function changed(listing: Listing, path: string): string {
  return `${listing.entry.name}'s ${path} is not the one that was listed, so it is not installed. It may have changed since; the index needs updating first.`;
}

async function checkListed(listing: Listing, path: string, bytes: Uint8Array, expected: string): Promise<void> {
  const actual = await listing.sha256(bytes);
  if (actual === null) throw new SourceProblem('This page cannot check a download (it needs https or localhost), so nothing from the index is installed here.');
  if (actual !== expected) throw new SourceProblem(changed(listing, path));
}

function manifestId(manifestText: string): unknown {
  try {
    return (JSON.parse(manifestText) as { id?: unknown } | null)?.id;
  } catch {
    return undefined;
  }
}

function namedFiles(manifestText: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null) return [];
  const manifest = raw as { instructions?: unknown; data?: unknown; assets?: unknown };
  const paths = new Set<string>();
  if (typeof manifest.instructions === 'string') paths.add(manifest.instructions);
  if (typeof manifest.data === 'object' && manifest.data !== null) for (const path of Object.values(manifest.data)) if (typeof path === 'string') paths.add(path);
  if (Array.isArray(manifest.assets)) for (const asset of manifest.assets) if (typeof asset === 'object' && asset !== null && typeof (asset as { path?: unknown }).path === 'string') paths.add((asset as { path: string }).path);
  return [...paths];
}

async function downloadBytes(url: URL, fetcher: typeof fetch): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(url.href);
  } catch {
    throw new SourceProblem(unreachable(url));
  }
  if (!response.ok) throw new SourceProblem(`${url.href} answered ${response.status}.`, response.status);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A browser cannot tell a server that is down from one that refuses other sites (no CORS header):
 * both are a failed fetch. The sentence says both, naming the host.
 */
export function unreachable(url: URL): string {
  return `Could not download from ${url.host}: it may be offline, or it does not allow downloads from other sites (it needs to send Access-Control-Allow-Origin).`;
}
