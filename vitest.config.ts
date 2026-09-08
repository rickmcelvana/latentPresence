import { defineConfig } from 'vitest/config';

// One vitest run for the whole workspace. Each member directory supplies its own
// environment: packages are plain node, apps/web brings jsdom through its vite config.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/web'],
  },
});
