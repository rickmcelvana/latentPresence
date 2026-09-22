import { expect, test, type Page } from '@playwright/test';

/**
 * The Phase 1 end-to-end test (P1-T14).
 *
 * Everything below the browser is already covered by 894 unit tests. What only a real
 * browser can tell us is whether the *wiring* holds: `getUserMedia` reaching a capture
 * `AudioWorklet`, Silero running as wasm in a worker, the turn detector ending a turn on
 * real frame timing, the machine moving through its states, a reply reaching the playback
 * worklet, and the barge-in gate cutting it when the microphone speaks again. Those are the
 * things a unit test mocks away and a browser upgrade can break.
 *
 * The audio is a looping file of two utterances (`pnpm e2e:fixture`), so the character is
 * always talked over eventually — barge-in is a fact about the wiring here, not a race.
 *
 * Runs against `/dev/e2e`, not `/dev/voice`: the model, the voice and recognition are fakes,
 * so CI needs no WebGPU and downloads nothing but Silero's 2.2 MB.
 */

const WEIGHTS = /huggingface\.co/u;

/** Poll `window.e2eHandle` until `predicate` holds, then return it. */
async function until(page: Page, predicate: (handle: NonNullable<typeof globalThis.e2eHandle>) => boolean, timeout = 40_000) {
  const started = Date.now();
  for (;;) {
    const handle = await page.evaluate(() => globalThis.e2eHandle);
    if (handle !== undefined) {
      expect(handle.error, 'the page reported an error').toBeNull();
      if (predicate(handle)) return handle;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`timed out waiting; last state was ${JSON.stringify(handle?.states)} (${handle?.status ?? 'no status'})`);
    }
    await page.waitForTimeout(250);
  }
}

test('a spoken turn, an answer, and a barge-in — with no weights fetched before consent', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const weightRequests: string[] = [];
  page.on('request', (request) => {
    if (WEIGHTS.test(request.url())) weightRequests.push(request.url());
  });

  await page.goto('/dev/e2e');
  await expect(page.getByTestId('agree')).toBeVisible();

  // **P1-T13's done-when, in a real browser.** The unit tests prove the gate structurally;
  // this proves it against the actual network. Nothing has been agreed to yet, so nothing
  // may have been fetched — and this is the assertion a `fetch` wrapper could never have
  // made, because onnxruntime-web fetches weights from inside the worker.
  expect(weightRequests, 'weights were fetched before consent was given').toEqual([]);

  await page.getByTestId('agree').click();

  // The turn: speech in, a turn end, an answer, and the machine in `speaking`.
  const answering = await until(page, (handle) => handle.states.includes('speaking'));
  expect(answering.states.slice(0, 3)).toEqual(['listening', 'thinking', 'speaking']);
  expect(answering.events.map((event) => event.type)).toEqual(
    expect.arrayContaining(['user.speech.started', 'user.speech.ended', 'user.turn.ended', 'user.transcript', 'assistant.sentence']),
  );

  // Silero, and only Silero: the gate let through exactly what was agreed to.
  expect(weightRequests.length, 'a model other than Silero was fetched').toBeGreaterThan(0);
  expect(weightRequests.every((url) => url.includes('silero'))).toBe(true);

  // The barge-in: the microphone speaks again while the character is talking.
  const interrupted = await until(page, (handle) => handle.events.some((event) => event.type === 'assistant.interrupted'));
  expect(interrupted.states).toContain('interrupted');

  const cut = interrupted.events.find((event) => event.type === 'assistant.interrupted');
  // What the user heard: a real prefix, and not the whole answer — an empty prefix would
  // mean the fade cut before a word, and the whole answer would mean nothing was cut.
  expect(cut?.spokenPrefix ?? '').not.toBe('');
  expect((cut?.spokenPrefix ?? '').length).toBeLessThan(150);

  // It settles rather than sticking in `interrupted` (P1-T08: the machine leaves on
  // `assistant.message`, not on the first sentence's `audio.ended`).
  const settled = await until(page, (handle) => handle.states.lastIndexOf('listening') > handle.states.indexOf('interrupted'));
  expect(settled.states.at(-1)).toBe('listening');

  expect(consoleErrors).toEqual([]);
});
