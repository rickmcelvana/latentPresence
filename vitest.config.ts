import { defineConfig } from 'vitest/config';

// One vitest run for the whole workspace. Each member directory supplies its own
// environment: packages are plain node, apps/web brings jsdom through its vite config.
// `site/` is static HTML with no package of its own, so its project is declared here.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/web',
      { test: { name: 'site', include: ['site/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
