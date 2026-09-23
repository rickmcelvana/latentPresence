import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

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
 * `@pixiv/three-vrm` and `three/examples/jsm` were to come out at **P2-T01**, and stay:
 * P2-T01 built the renderer, but its only page is the dev-only `/dev/avatar`, so a VRM
 * in a production chunk still means a dev page leaked. They come out when a production
 * route first mounts the renderer — the call layout, P2-T06 — and not before.
 */
function assertSpikeExcludedFromBuild(): Plugin {
  const forbidden = [
    '@pixiv/three-vrm',
    'three/examples/jsm',
    // `/dev/voice` (P1-T08) and `/dev/e2e` (P1-T14). Each is a handle those pages hang on
    // `globalThis` for a person, or for Playwright, to read — nothing else writes either
    // name, and neither survives minification as a property name.
    'voiceHarness',
    'e2eHandle',
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

export default defineConfig({
  plugins: [react(), assertSpikeExcludedFromBuild()],
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
