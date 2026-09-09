import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Fails the build if the Spike A route reaches production.
 *
 * The route is guarded by `import.meta.env.DEV`, but that alone does not keep it out of
 * the bundle: Rollup emits a chunk for a dynamic import whether or not the branch that
 * reaches it can run. The first build of the spike shipped three worker chunks and a
 * 21 MB ONNX Runtime wasm to a route nobody could open. The guard that works is
 * returning before the import so the branch is provably dead — and this plugin is what
 * says whether that is still true.
 *
 * P1 puts speech recognition and synthesis into the product for real. When that happens
 * this plugin is the thing to delete, deliberately, rather than a surprise 21 MB.
 */
function assertSpikeExcludedFromBuild(): Plugin {
  const forbidden = [
    'onnxruntime',
    '@huggingface/transformers',
    'kokoro-js',
    'spike-capture',
    'smart-turn',
    // P0-T05. These two are the entries to delete at P2-T01, deliberately: the avatar
    // stops being dev-only the moment the stage is real, and that is the one line of this
    // guard that is meant to come out rather than stay forever.
    '@pixiv/three-vrm',
    'three/examples/jsm',
  ];

  return {
    name: 'assert-spike-excluded-from-build',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith('.wasm')) {
          this.error(
            `${fileName} is in the production bundle. The spike models are dev-only ` +
              '(P0-T04, P0-T07).',
          );
        }
        if (output.type !== 'chunk') continue;
        for (const needle of forbidden) {
          if (output.code.includes(needle)) {
            this.error(
              `${fileName} references "${needle}". A spike route has reached the ` +
                'production bundle; it is meant to be dropped as dead code (P0-T04, P0-T07).',
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
