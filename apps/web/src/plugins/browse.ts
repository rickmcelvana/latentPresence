import { PluginIndexEntrySchema, PLUGIN_INDEX_FORMAT, type PluginIndexEntry } from '@latentpresence/protocol';
import { pageSha256 } from './inspect';
import { SourceProblem, sourceFromUrl, unreachable, type PluginSource } from './sources';

/**
 * Browse (ADR-72 item 9, P10-T09): the index on latentpresence.com, fetched only when the person
 * presses Browse, and a listed plugin installed with every file checked against the hash it was
 * listed with. Nothing is sent but the request for the file; the index counts nothing.
 */
export const PLUGIN_INDEX_URL = 'https://latentpresence.com/plugins/index.json';

export interface PluginIndexRead {
  readonly plugins: readonly PluginIndexEntry[];
  /** Entries this app could not read (a newer shape, a typo in the index): left out, and counted. */
  readonly skipped: number;
}

export async function fetchPluginIndex(fetcher: typeof fetch, address: string = PLUGIN_INDEX_URL): Promise<PluginIndexRead> {
  const url = new URL(address);
  let response: Response;
  try {
    response = await fetcher(url.href);
  } catch {
    throw new SourceProblem(unreachable(url));
  }
  if (!response.ok) throw new SourceProblem(`The index at ${url.host} answered ${response.status}.`, response.status);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new SourceProblem(`The index at ${url.host} is not JSON.`);
  }
  const index = raw as { format?: unknown; plugins?: unknown } | null;
  if (index === null || typeof index !== 'object' || !Array.isArray(index.plugins)) throw new SourceProblem(`The index at ${url.host} is not a plugin index.`);
  if (index.format !== PLUGIN_INDEX_FORMAT) throw new SourceProblem(`The index is format ${String(index.format)}, which this version of the app does not read; an update may.`);
  // One bad entry does not hide the rest.
  const plugins: PluginIndexEntry[] = [];
  let skipped = 0;
  for (const entry of index.plugins) {
    const parsed = PluginIndexEntrySchema.safeParse(entry);
    if (parsed.success) plugins.push(parsed.data);
    else skipped += 1;
  }
  return { plugins: plugins.toSorted((a, b) => a.name.localeCompare(b.name)), skipped };
}

/** A listed plugin, every file checked against the index (a changed one is refused, in words). */
export function sourceFromIndex(entry: PluginIndexEntry, fetcher: typeof fetch, sha256: (bytes: Uint8Array) => Promise<string | null> = pageSha256): Promise<PluginSource> {
  return sourceFromUrl(entry.manifest, fetcher, { entry, sha256 });
}
