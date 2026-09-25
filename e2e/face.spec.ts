import { expect, test } from '@playwright/test';

/**
 * Face reading on `/chat` (P3-T06). The done-when: **no camera access before consent**.
 *
 * Proven against the real page in a real browser, because the two ways it could go wrong
 * are both invisible to a unit test: a `getUserMedia({ video })` fired by something mounted
 * with the page, and a model request made from inside a worker. So `getUserMedia` is
 * wrapped before the app loads and every call is recorded with its constraints, and every
 * request the page and its workers make is recorded with its URL.
 *
 * Chrome's fake camera (`--use-fake-device-for-media-stream`) draws no face, so after
 * consent the light reads "no face seen" — which is the wiring working: frames reached the
 * landmarker and came back as a reading. And **nothing may ever go to MediaPipe's metrics
 * endpoint** (ADR-34): the pin and the worker's guard both answer for that, and this is
 * where a browser says whether they did.
 */

const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

test('face reading touches neither the camera nor the network before consent', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? 'http://localhost:5173').origin;
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) offOrigin.push(request.url());
  });
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
    const calls: MediaStreamConstraints[] = [];
    (window as unknown as { gumCalls: MediaStreamConstraints[] }).gumCalls = calls;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints?: MediaStreamConstraints) => {
      calls.push(constraints ?? {});
      return original(constraints);
    };
  });
  const cameraCalls = () => page.evaluate(() => (window as unknown as { gumCalls: MediaStreamConstraints[] }).gumCalls.filter((c) => c.video !== undefined && c.video !== false).length);

  await page.goto('/chat');
  const toggle = page.getByRole('button', { name: 'Read my face' });
  await expect(toggle).toBeVisible();
  expect(await cameraCalls(), 'the camera was opened by loading the page').toBe(0);

  // Asking is not agreeing: the card is up, and still nothing has been touched.
  await toggle.click();
  await expect(page.getByText('Read your expression from the camera?')).toBeVisible();
  await expect(page.getByText(/no frame is saved or sent anywhere/u)).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await cameraCalls(), 'the camera was opened before consent').toBe(0);
  expect(offOrigin, 'something was fetched before consent').toEqual([]);

  // "Not now" leaves it that way.
  const card = page.locator('.consent-screen', { hasText: 'Read your expression from the camera?' });
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await cameraCalls()).toBe(0);

  // Agreed: the camera comes on, the model comes down, and the light shows a reading.
  await toggle.click();
  await card.getByRole('button', { name: 'Turn on face reading' }).click();
  const light = page.getByTestId('face-indicator');
  await expect(light).toContainText('Reading your face', { timeout: 30_000 });
  expect(await cameraCalls()).toBe(1);
  expect(offOrigin, 'something other than the one model was fetched').toEqual([MODEL]);

  // Off means off: the light goes, and the camera it turned on goes with it.
  await toggle.click();
  await expect(light).toHaveCount(0);
  await expect(page.locator('.call-pip-video')).toHaveCount(0);
  expect(offOrigin.some((url) => url.includes('odml.pa.googleapis.com'))).toBe(false);
  expect(errors).toEqual([]);
});
