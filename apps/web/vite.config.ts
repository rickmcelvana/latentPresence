import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { checkBundle, formatRoutes, type BuiltBundle } from './src/perf/bundle-budget.ts';
import { BUNDLE_BUDGETS } from './src/perf/budgets.ts';
import { cspValue } from './src/security/csp.ts';

/**
 * Fails the build if a dev-only route reaches production — the avatar spike (P0-T05) and
 * the two harnesses (P1-T08, P1-T14).
 *
 * The routes are guarded by `import.meta.env.DEV`, but that alone does not keep them out of
 * the bundle: Rollup emits a chunk for a dynamic import whether or not the branch that
 * reaches it can run. The first build of the spike shipped three worker chunks and a 21 MB
 * ONNX Runtime wasm to a route nobody could open. The guard that works is returning before
 * the import so the branch is provably dead — and this plugin is what says whether that is
 * still true.
 *
 * **P1-T15 rewrote the needles rather than deleting the plugin, and it had to.** Until voice
 * reached a real route this list was ONNX Runtime, transformers.js, kokoro-js and the two
 * worklet names, and any of them in a chunk meant a dev page had leaked. `/chat` ships the
 * same pipeline now, so all five are *expected* in a production bundle — a guard that still
 * named them would fail every build, and one that named nothing would let the next dev page
 * leak in silence. What replaces them are two names only the dev pages ever write, so the
 * guard is the same instrument measuring the same thing instead of being retired with its
 * subject. The `.wasm` assertion went with the rest: the pipeline's own wasm is the point.
 *
 * `@pixiv/three-vrm` and `three/examples/jsm` came out at **P2-T06**: `/chat`'s call layout
 * (`CallStage`) is the first production route to mount `VrmAvatarRenderer`, so both names
 * are now *expected* in a production chunk — a guard that still named them would fail every
 * build, the same reasoning P1-T15 already applied to the voice pipeline above. What
 * replaces them are two needles only the two avatar dev pages still carry: `/spike/avatar`
 * (`AvatarStage.tsx`) is the only file importing `@react-three/fiber` — `CallStage` drives
 * three.js directly, not through react-three-fiber (`renderer.ts`'s own comment on that
 * choice) — and `/dev/avatar` (`AvatarDebug.tsx`) is the only file naming
 * `avatar-debug-canvas`, one of its own CSS classes and not a real class anything else
 * uses, so it survives minification as a plain string the way `voiceHarness` does as a
 * property name.
 */
function assertSpikeExcludedFromBuild(): Plugin {
  const forbidden = [
    // `/dev/voice` (P1-T08) and `/dev/e2e` (P1-T14). Each is a handle those pages hang on
    // `globalThis` for a person, or for Playwright, to read — nothing else writes either
    // name, and neither survives minification as a property name.
    'voiceHarness',
    'e2eHandle',
    // `/dev/ser` (P3-T05): the handle that page hangs on `globalThis`, as above.
    'serBench',
    // `/dev/face` (P3-T06): the same.
    'faceBench',
    // `/dev/perf` (P9-T02): the same.
    'perfHandle',
    // `/spike/avatar` (Spike B) and `/dev/avatar` (P2-T01), per the comment above.
    '@react-three/fiber',
    'avatar-debug-canvas',
  ];

  return {
    name: 'assert-spike-excluded-from-build',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const needle of forbidden) {
          if (output.code.includes(needle)) {
            this.error(
              `${fileName} references "${needle}". A dev-only route has reached the ` +
                'production bundle; it is meant to be dropped as dead code (P0-T04, P1-T15).',
            );
          }
        }
      }
    },
  };
}

/**
 * P9-T02 (ADR-68): fails the build when a page downloads more than its budget before it
 * draws, or a file loaded later outgrows its ceiling (`src/perf/budgets.ts`). The rules are
 * `checkBundle`'s, tested without a build; this only describes the real bundle to it.
 */
function enforceBundleBudgets(): Plugin {
  return {
    name: 'enforce-bundle-budgets',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const built: BuiltBundle = {
        chunks: Object.values(bundle).flatMap((output) =>
          output.type === 'chunk'
            ? [
                {
                  fileName: output.fileName,
                  name: output.name,
                  isEntry: output.isEntry,
                  bytes: byteLength(output.code),
                  gzipBytes: gzip(output.code),
                  imports: output.imports,
                  css: [...(output.viteMetadata?.importedCss ?? [])],
                },
              ]
            : [],
        ),
        assets: Object.values(bundle).flatMap((output) =>
          output.type === 'asset' ? [{ fileName: output.fileName, bytes: byteLength(output.source), gzipBytes: gzip(output.source) }] : [],
        ),
      };
      const report = checkBundle(built, BUNDLE_BUDGETS);
      this.info(`bundle budgets (gzip before each page draws):\n${formatRoutes(report)}`);
      if (report.failures.length > 0) this.error(`over budget (ADR-68):\n  ${report.failures.join('\n  ')}`);
    },
  };
}

function gzip(source: string | Uint8Array): number {
  return gzipSync(source).byteLength;
}

/** P9-T03 (ADR-69): the Content Security Policy, as the first thing in `<head>`, in builds only. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: cspValue() }, injectTo: 'head-prepend' },
    ],
  };
}

function byteLength(source: string | Uint8Array): number {
  return typeof source === 'string' ? Buffer.byteLength(source) : source.byteLength;
}

export default defineConfig({
  plugins: [react(), assertSpikeExcludedFromBuild(), enforceBundleBudgets(), contentSecurityPolicy()],
  // **Every dependency only a worker imports, pre-bundled when the server starts.** Vite's
  // scan starts from `index.html` and does not follow `new Worker(new URL(...))`, so these
  // were discovered the first time a worker loaded, and each discovery re-bundles them
  // together — they share onnxruntime-web. On 2026-09-27 the face worker's first use
  // (`@mediapipe/tasks-vision`, added in P3-T06) did that mid-session, the Smart Turn
  // worker got a transformers.js chunk asking the new onnxruntime chunk for an export it
  // no longer had, and `/chat`'s Start voice hung. Named here, they are bundled once.
  optimizeDeps: {
    // The nested form: they are `ml-web`'s dependencies, not the app's, and pnpm keeps them there.
    include: ['@huggingface/transformers', 'onnxruntime-web', 'kokoro-js', '@mediapipe/tasks-vision'].map((dep) => `@latentpresence/ml-web > ${dep}`),
  },
  // `/dev/face` (P3-T06) reads the generated face set from `live/out/faces` through Vite's
  // `/@fs/` route; this is where that folder is on this machine. Only that page names it.
  define: {
    FACE_SET_DIR: JSON.stringify(fileURLToPath(new URL('../../packages/ml-web/live/out/faces/', import.meta.url)).replaceAll('\\', '/')),
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
