import { expect, test } from '@playwright/test';
import { STAGE_BUDGET } from '../apps/web/src/perf/budgets';

/**
 * The stage's budget (P9-T02, ADR-68), on `/dev/perf` — `/chat` as a person gets it, with
 * the renderer kept so a frame's cost can be read.
 *
 * **Not a frame rate.** This Chromium draws with SwiftShader, on a CPU, so its frame time
 * says nothing about a GPU. What it can say exactly is what 60 fps at 1080p depends on and
 * this code decides: the draw calls, the triangles, the shader programs, the textures and
 * their memory, and the JavaScript heap — measured on the default body, the room and its
 * shadow, at 1920×1080. The frame rate itself is R-13's, on real hardware.
 *
 * Downloads the placeholder body (10.8 MB, from pixiv's repository on GitHub); consent for
 * it is granted in storage, as a returning person's would be.
 */

test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

test("a frame of the call, and the page's memory, inside the stage budget", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.addInitScript(() => {
    // A chat model has to be chosen for `/chat` to render its call; nothing is sent to it.
    localStorage.setItem(
      'latentpresence.settings.v1',
      JSON.stringify({
        version: 1,
        companionUrl: 'http://127.0.0.1:8787',
        llm: { endpoint: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'e2e-unused', temperature: null },
        tts: { kind: 'kokoro-browser', voiceId: 'af_heart', speed: 1 },
        stt: { kind: 'moonshine-browser', model: 'moonshine-tiny' },
      }),
    );
    localStorage.setItem('latentpresence.consent.v1', JSON.stringify(['pixiv/VRM1_Constraint_Twist_Sample.vrm']));
  });

  await page.goto('/dev/perf');
  await page.waitForFunction(() => globalThis.perfHandle?.bodyLoaded() === true, null, { timeout: 90_000 });
  // A second of frames with her on stage: the shadow map, every material's program and the
  // boards' first draw are behind it.
  await page.waitForTimeout(1_000);
  const stats = await page.evaluate(() => globalThis.perfHandle?.stats() ?? null);
  expect(stats, 'the stage has no surface').not.toBeNull();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const heapBytes = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? Number.NaN;

  const measured = { ...stats!, heapBytes };
  console.log(`stage at 1920x1080: ${JSON.stringify(measured)}`);
  test.info().annotations.push({ type: 'stage', description: JSON.stringify(measured) });

  expect(errors).toEqual([]);
  expect(measured.pixels, 'the canvas is not drawing at 1080p').toBe(1920 * 1080);
  expect(measured.drawCalls).toBeGreaterThan(0);
  expect.soft(measured.drawCalls, 'draw calls a frame').toBeLessThanOrEqual(STAGE_BUDGET.drawCalls);
  expect.soft(measured.triangles, 'triangles a frame').toBeLessThanOrEqual(STAGE_BUDGET.triangles);
  expect.soft(measured.programs, 'shader programs').toBeLessThanOrEqual(STAGE_BUDGET.programs);
  expect.soft(measured.textures, 'textures on the GPU').toBeLessThanOrEqual(STAGE_BUDGET.textures);
  expect.soft(measured.textureBytes, 'texture memory').toBeLessThanOrEqual(STAGE_BUDGET.textureBytes);
  expect.soft(measured.heapBytes, 'JavaScript heap').toBeLessThanOrEqual(STAGE_BUDGET.heapBytes);
});
