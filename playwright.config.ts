import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * The Phase 1 end-to-end test (P1-T14).
 *
 * **Not part of `pnpm gate`, on purpose.** The gate is the thing a contributor runs before
 * every commit and CI runs on two operating systems; putting a browser download in it would
 * cost everyone 115 MB and minutes for a test that only ever exercises Chromium. This
 * follows the `vector` job's precedent in `.github/workflows/ci.yml`: a separate script and
 * a separate CI job, so the fast loop stays fast.
 *
 * **The browser flags are the test.** `--use-fake-device-for-media-stream` gives
 * `getUserMedia` a synthetic microphone with no hardware and no permission prompt, which is
 * what makes the input half of the pipeline exercisable at all in CI.
 * `--autoplay-policy=no-user-gesture-required` matters because `createAudioOutput` resumes
 * an `AudioContext`, and a context created without a gesture stays suspended — rendering
 * nothing, which would look exactly like a broken playback queue.
 */
export default defineConfig({
  testDir: './e2e',
  // One worker: every test drives the same audio device and the same dev server.
  workers: 1,
  fullyParallel: false,
  // The whole suite is meant to run in well under two minutes (the plan's done-when).
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            // **The built-in fake device is not enough.** It makes Silero fire exactly once,
            // at the start of the stream — measured over 30 s (`docs/SURFACE.md`) — which is
            // a turn but never a barge-in. This file is two utterances with a gap, looped by
            // Chrome, so the character always gets talked over. `pnpm e2e:fixture` rebuilds it.
            `--use-file-for-fake-audio-capture=${fileURLToPath(new URL('./e2e/fixtures/speech.wav', import.meta.url))}`,
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @latentpresence/web exec vite --port 5173 --strictPort',
    url: 'http://localhost:5173/',
    reuseExistingServer: process.env.CI === undefined,
    timeout: 120_000,
  },
});
