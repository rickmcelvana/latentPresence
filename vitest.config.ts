import { defineConfig } from 'vitest/config';

// One vitest run for the whole workspace. Each member directory supplies its own
// environment: packages are plain node, apps/web brings jsdom through its vite config.
// (The `site` project went with `site/`, 2026-10-17.)
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/web',
    ],
  },
});
