/**
 * P9-T02: what a person downloads before a page draws, read from the build's own chunk graph.
 *
 * A route's cost is the entry chunk, every chunk it imports statically, the same for each of
 * the route's lazy chunks (`ChatPage`, then the `CallStage` it suspends on), and the CSS those
 * chunks carry. Dynamic imports below that are not counted: they load when something is used
 * (a provider, the voice), and the files they bring are held to a ceiling of their own.
 *
 * Pure over a plain description of the bundle, so the rules are tested without a build; the
 * build plugin in `vite.config.ts` is the only thing that reads a real one.
 */

export interface BuiltChunk {
  readonly fileName: string;
  /** Rolldown's chunk name: the lazy module's file name (`ChatPage`), `index` for the entry. */
  readonly name: string;
  readonly isEntry: boolean;
  readonly bytes: number;
  readonly gzipBytes: number;
  /** Static imports, by file name. */
  readonly imports: readonly string[];
  /** The CSS files this chunk brings, by file name. */
  readonly css: readonly string[];
}

export interface BuiltAsset {
  readonly fileName: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

export interface BuiltBundle {
  readonly chunks: readonly BuiltChunk[];
  readonly assets: readonly BuiltAsset[];
}

export interface RouteBudget {
  /** The lazy chunks that must load before the route draws, by chunk name; empty for the boot screen. */
  readonly chunks: readonly string[];
  readonly maxGzipBytes: number;
}

export interface FileBudget {
  /** The file name without its hash, e.g. `kokoro.worker.js` or `ort-wasm-simd-threaded.jsep.wasm`. */
  readonly stem: string;
  readonly maxBytes: number;
}

export interface BundleBudgets {
  readonly routes: Readonly<Record<string, RouteBudget>>;
  readonly files: readonly FileBudget[];
  /** Any lazy JS or wasm file larger than this must have a `files` entry of its own. */
  readonly unbudgetedFileMaxBytes: number;
}

export interface RouteCost {
  readonly route: string;
  readonly gzipBytes: number;
  readonly maxGzipBytes: number;
  /** The largest files in it, largest first, for the failure message. */
  readonly largest: readonly { readonly fileName: string; readonly gzipBytes: number }[];
}

export interface BundleReport {
  readonly routes: readonly RouteCost[];
  readonly failures: readonly string[];
}

/** `assets/kokoro.worker-DxZhxqKH.js` → `kokoro.worker.js`: the file name with the build's hash taken out. */
export function fileStem(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  return base.replace(/-[\w-]{8}(\.\w+)$/u, '$1');
}

/** The file names a route downloads: its chunks, their static imports, and their CSS. */
export function routeFiles(bundle: BuiltBundle, chunkNames: readonly string[]): Set<string> {
  const byFile = new Map(bundle.chunks.map((chunk) => [chunk.fileName, chunk]));
  const files = new Set<string>();
  const visit = (chunk: BuiltChunk): void => {
    if (files.has(chunk.fileName)) return;
    files.add(chunk.fileName);
    for (const css of chunk.css) files.add(css);
    for (const imported of chunk.imports) {
      const next = byFile.get(imported);
      if (next !== undefined) visit(next);
    }
  };
  const entries = bundle.chunks.filter((chunk) => chunk.isEntry);
  if (entries.length === 0) throw new Error('the bundle has no entry chunk');
  entries.forEach(visit);
  for (const name of chunkNames) {
    const found = bundle.chunks.filter((chunk) => chunk.name === name && !chunk.isEntry);
    if (found.length !== 1) throw new Error(`expected one chunk named ${name}, found ${found.length}`);
    visit(found[0] as BuiltChunk);
  }
  return files;
}

const kB = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`;

/** Every route's cost against its budget, and every file over its ceiling. */
export function checkBundle(bundle: BuiltBundle, budgets: BundleBudgets): BundleReport {
  const gzipOf = new Map<string, number>([
    ...bundle.chunks.map((chunk) => [chunk.fileName, chunk.gzipBytes] as const),
    ...bundle.assets.map((asset) => [asset.fileName, asset.gzipBytes] as const),
  ]);
  const failures: string[] = [];

  const routes = Object.entries(budgets.routes).map(([route, budget]): RouteCost => {
    const files = [...routeFiles(bundle, budget.chunks)].map((fileName) => ({ fileName, gzipBytes: gzipOf.get(fileName) ?? 0 }));
    const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
    const largest = files.toSorted((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 3);
    if (gzipBytes > budget.maxGzipBytes) {
      failures.push(
        `${route}: ${kB(gzipBytes)} gzipped before it draws, over its ${kB(budget.maxGzipBytes)} budget ` +
          `(largest: ${largest.map((file) => `${file.fileName} ${kB(file.gzipBytes)}`).join(', ')})`,
      );
    }
    return { route, gzipBytes, maxGzipBytes: budget.maxGzipBytes, largest };
  });

  // The chunks a route loads are counted above; the ceiling is for what loads later.
  const counted = new Set(Object.values(budgets.routes).flatMap((budget) => [...routeFiles(bundle, budget.chunks)]));
  const sized = [
    ...bundle.assets.map((asset) => ({ fileName: asset.fileName, bytes: asset.bytes })),
    ...bundle.chunks.filter((chunk) => !counted.has(chunk.fileName)).map((chunk) => ({ fileName: chunk.fileName, bytes: chunk.bytes })),
  ];
  const seen = new Set<string>();
  for (const file of sized) {
    if (!/\.(?:js|wasm)$/u.test(file.fileName)) continue;
    const stem = fileStem(file.fileName);
    const budget = budgets.files.find((entry) => entry.stem === stem);
    if (budget !== undefined) {
      seen.add(stem);
      // Raw bytes: the size a dependency bump changes, however the server compresses it.
      if (file.bytes > budget.maxBytes) failures.push(`${file.fileName}: ${kB(file.bytes)}, over its ${kB(budget.maxBytes)} ceiling`);
    } else if (file.bytes > budgets.unbudgetedFileMaxBytes) {
      failures.push(
        `${file.fileName}: ${kB(file.bytes)} and no budget of its own (anything over ${kB(budgets.unbudgetedFileMaxBytes)} needs ` +
          `an entry in apps/web/src/perf/budgets.ts)`,
      );
    }
  }
  for (const budget of budgets.files) {
    if (!seen.has(budget.stem)) failures.push(`${budget.stem}: budgeted but not in the build (remove its entry, or the file was renamed)`);
  }

  return { routes, failures };
}

/** One line a route, for the build log. */
export function formatRoutes(report: BundleReport): string {
  return report.routes
    .map((route) => `  ${route.route.padEnd(10)} ${kB(route.gzipBytes).padStart(9)} of ${kB(route.maxGzipBytes)}`)
    .join('\n');
}
