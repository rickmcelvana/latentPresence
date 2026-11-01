import { expect, test } from '@playwright/test';

/**
 * The built pages under their Content Security Policy (P9-T03, ADR-69), served by `vite
 * preview` from `apps/web/dist` — the policy is written into the build only, so the other specs,
 * on the dev server, never meet it. A dependency that starts needing `eval`, an inline script or
 * a `blob:` worker on the page fails here, not on a tester's machine.
 *
 * Every violation the page reports is recorded from before its first script runs.
 */

const PREVIEW = 'http://localhost:4173';

test.use({ baseURL: PREVIEW });

for (const path of ['/welcome', '/settings', '/chat']) {
  test(`${path} runs under its policy with nothing refused`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { cspViolations: string[] }).cspViolations = seen;
      document.addEventListener('securitypolicyviolation', (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
      // `/chat` renders its call only once a chat model is chosen; nothing is sent to it.
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
      // `/chat` loads her body, as a returning person's would: its textures are `blob:` images.
      localStorage.setItem('latentpresence.consent.v1', JSON.stringify(['pixiv/VRM1_Constraint_Twist_Sample.vrm']));
    });

    const body = path === '/chat' ? page.waitForResponse((response) => response.url().includes('VRM1_Constraint_Twist_Sample.vrm'), { timeout: 60_000 }) : null;
    await page.goto(path);
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(policy, 'the build wrote no policy').toContain("script-src 'self' 'wasm-unsafe-eval'");
    await page.waitForLoadState('networkidle');
    if (body !== null) {
      // Her body downloaded and was handed to three.js; a second for its textures to decode.
      await (await body).finished();
      await page.waitForTimeout(1_000);
    }

    // The policy is live: an injected script — what it is there to stop — does not run. (Not
    // `eval` from here: what Playwright evaluates goes through DevTools, which the policy does
    // not govern; a `<script>` the page's own DOM is handed is what an injection looks like.)
    const ran = await page.evaluate(async () => {
      const script = document.createElement('script');
      script.textContent = 'window.injectedRan = true';
      document.head.append(script);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return (window as unknown as { injectedRan?: boolean }).injectedRan === true;
    });
    expect(ran, 'an injected script ran: the policy is not enforced').toBe(false);

    const violations = await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
    // The one violation the check above causes, and nothing the page did by itself.
    expect(violations).toEqual(['script-src-elem inline']);
    expect(errors).toEqual([]);
  });
}
