import { PINS, type PinnedFile } from './pins';

// The production-safe half of the registry (P9-T05, ADR-70): no ONNX Runtime, no DOM.
export * from './integrity';
export * from './pins';
export * from './wanted';

/** One pinned file. A name that is not in the table is a mistake in this repository: it throws. */
export function pinnedFile(source: string, path: string): PinnedFile {
  const file = PINS[source]?.files[path];
  if (file === undefined) throw new Error(`no pin for ${source}/${path}; add it to tools/pin-models.ts`);
  return file;
}

/** The address of one pinned file: it names a commit, so it cannot move. */
export function pinnedUrl(source: string, path: string): string {
  pinnedFile(source, path);
  return `${PINS[source]?.base ?? ''}${path}`;
}

/** What these files add up to: the number a consent screen shows. */
export function pinnedBytes(source: string, paths: readonly string[]): number {
  return paths.reduce((sum, path) => sum + pinnedFile(source, path).bytes, 0);
}

export function pinnedRevision(source: string): string {
  const pin = PINS[source];
  if (pin === undefined) throw new Error(`no pin for ${source}`);
  return pin.revision;
}
