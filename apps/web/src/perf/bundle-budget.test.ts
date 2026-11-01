import { describe, expect, it } from 'vitest';
import { checkBundle, fileStem, routeFiles, type BuiltBundle, type BuiltChunk, type BundleBudgets } from './bundle-budget';

function chunk(fileName: string, name: string, gzipBytes: number, imports: string[] = [], extra: Partial<BuiltChunk> = {}): BuiltChunk {
  return { fileName, name, isEntry: false, bytes: gzipBytes * 3, gzipBytes, imports, css: [], ...extra };
}

/** An entry with a shared chunk, a page that imports it and a library, and a lazy SDK. */
const BUNDLE: BuiltBundle = {
  chunks: [
    chunk('assets/index-AAAAAAAA.js', 'index', 50_000, ['assets/react-BBBBBBBB.js'], { isEntry: true, css: ['assets/index-CCCCCCCC.css'] }),
    chunk('assets/react-BBBBBBBB.js', 'react', 40_000),
    chunk('assets/ChatPage-DDDDDDDD.js', 'ChatPage', 30_000, ['assets/react-BBBBBBBB.js', 'assets/vrm-EEEEEEEE.js']),
    chunk('assets/vrm-EEEEEEEE.js', 'vrm', 100_000),
    chunk('assets/llm-provider-FFFFFFFF.js', 'llm-provider', 120_000),
  ],
  assets: [
    { fileName: 'assets/index-CCCCCCCC.css', bytes: 30_000, gzipBytes: 6_000 },
    { fileName: 'assets/kokoro.worker-GGGGGGGG.js', bytes: 2_000_000, gzipBytes: 500_000 },
  ],
};

const BUDGETS: BundleBudgets = {
  routes: {
    boot: { chunks: [], maxGzipBytes: 96_000 },
    chat: { chunks: ['ChatPage'], maxGzipBytes: 226_000 },
  },
  files: [
    { stem: 'llm-provider.js', maxBytes: 400_000 },
    { stem: 'kokoro.worker.js', maxBytes: 2_000_000 },
  ],
  unbudgetedFileMaxBytes: 100_000,
};

describe('fileStem', () => {
  it('takes the hash out and keeps the extension, including hashes with dashes in them', () => {
    expect(fileStem('assets/kokoro.worker-DxZhxqKH.js')).toBe('kokoro.worker.js');
    expect(fileStem('assets/src-B1--mU11.js')).toBe('src.js');
    expect(fileStem('assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm')).toBe('ort-wasm-simd-threaded.jsep.wasm');
  });
});

describe('routeFiles', () => {
  it('is the entry, its static imports and CSS, and each named chunk with its own', () => {
    expect([...routeFiles(BUNDLE, [])].toSorted()).toEqual(['assets/index-AAAAAAAA.js', 'assets/index-CCCCCCCC.css', 'assets/react-BBBBBBBB.js']);
    expect(routeFiles(BUNDLE, ['ChatPage'])).toEqual(
      new Set(['assets/index-AAAAAAAA.js', 'assets/index-CCCCCCCC.css', 'assets/react-BBBBBBBB.js', 'assets/ChatPage-DDDDDDDD.js', 'assets/vrm-EEEEEEEE.js']),
    );
  });

  it('refuses a chunk name the build does not have, so a renamed page cannot go unmeasured', () => {
    expect(() => routeFiles(BUNDLE, ['Gone'])).toThrow(/one chunk named Gone, found 0/u);
  });
});

describe('checkBundle', () => {
  it('passes a bundle inside every budget and counts a shared chunk once', () => {
    const report = checkBundle(BUNDLE, BUDGETS);
    expect(report.failures).toEqual([]);
    expect(report.routes.map((route) => [route.route, route.gzipBytes])).toEqual([
      ['boot', 96_000],
      ['chat', 226_000],
    ]);
  });

  it('names the route, its size, its budget and its largest files when it is over', () => {
    const report = checkBundle(BUNDLE, { ...BUDGETS, routes: { chat: { chunks: ['ChatPage'], maxGzipBytes: 225_999 } } });
    expect(report.failures).toEqual([
      'chat: 226.0 kB gzipped before it draws, over its 226.0 kB budget (largest: assets/vrm-EEEEEEEE.js 100.0 kB, assets/index-AAAAAAAA.js 50.0 kB, assets/react-BBBBBBBB.js 40.0 kB)',
    ]);
  });

  it('holds a file loaded later to its ceiling in raw bytes', () => {
    const report = checkBundle(BUNDLE, { ...BUDGETS, files: [{ stem: 'llm-provider.js', maxBytes: 359_999 }, BUDGETS.files[1]!] });
    expect(report.failures).toEqual(['assets/llm-provider-FFFFFFFF.js: 360.0 kB, over its 360.0 kB ceiling']);
  });

  it('fails a large file with no budget of its own, so a new heavy dependency is a decision', () => {
    const report = checkBundle(BUNDLE, { ...BUDGETS, files: [BUDGETS.files[1]!] });
    expect(report.failures).toEqual([
      'assets/llm-provider-FFFFFFFF.js: 360.0 kB and no budget of its own (anything over 100.0 kB needs an entry in apps/web/src/perf/budgets.ts)',
    ]);
  });

  it('does not count a chunk a route already paid for against the file ceiling', () => {
    // vrm is 300 kB raw and unbudgeted, but /chat loads it before it draws.
    expect(checkBundle(BUNDLE, BUDGETS).failures).toEqual([]);
  });

  it('fails a budget whose file is gone, so a renamed worker cannot go unmeasured', () => {
    const report = checkBundle(BUNDLE, { ...BUDGETS, files: [...BUDGETS.files, { stem: 'gone.worker.js', maxBytes: 1 }] });
    expect(report.failures).toEqual(['gone.worker.js: budgeted but not in the build (remove its entry, or the file was renamed)']);
  });
});
