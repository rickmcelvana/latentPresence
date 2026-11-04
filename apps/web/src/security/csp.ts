/**
 * The page's Content Security Policy (P9-T03, ADR-69), written into `index.html` by the build
 * (`vite.config.ts`) as a `<meta>` so the hosted app and the desktop app's webview get the same
 * one. Not in development: Vite's dev server injects inline scripts for hot reload.
 *
 * **What it is for.** Everything the page holds — the API keys it can decrypt, her memory, and in
 * the desktop app the shell's commands — is one injected script away. React escapes what it
 * renders and nothing here writes HTML, so the policy is the second wall: no script runs that the
 * build did not ship.
 *
 * **What it cannot narrow.** The person brings their own model servers, anywhere (a cloud API,
 * Ollama on this machine or the LAN, a companion), so `connect-src` allows every http(s) and
 * websocket address; that is the product, not an oversight. `frame-ancestors` is ignored in a
 * `<meta>`, so the hosted app sends it as a header (`docs/deploy.md`).
 */
export const CONTENT_SECURITY_POLICY: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  // Only the build's own files. `'wasm-unsafe-eval'` compiles WebAssembly, and nothing else.
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  // The model workers and the audio worklets are the build's own files. This limits which workers
  // start, not what they load: a worker does not inherit a `<meta>` policy (ADR-70, `cdn-guard.ts`).
  'worker-src': ["'self'"],
  // `ipc:` and `http://ipc.localhost` are the desktop shell's commands (Tauri 2).
  'connect-src': ["'self'", 'https:', 'http:', 'wss:', 'ws:', 'data:', 'blob:', 'ipc:'],
  // A body read from disk or from the cache is a `blob:`; three.js decodes textures from both.
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'data:', 'blob:'],
  // React sets styles through the CSSOM, which a policy does not govern; no `<style>` is injected.
  'style-src': ["'self'"],
  'font-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
};

/** The policy as a header or `<meta content>` value. */
export function cspValue(policy: Readonly<Record<string, readonly string[]>> = CONTENT_SECURITY_POLICY): string {
  return Object.entries(policy)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}
