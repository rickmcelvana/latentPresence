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

export default defineConfig({
  plugins: [react(), assertSpikeExcludedFromBuild()],
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
