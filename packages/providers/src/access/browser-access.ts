/**
 * How a browser page reaches each endpoint (P1-T10, ADR-29).
 *
 * Every entry is a measurement, not a reading of the vendor's docs: a preflight and a real
 * request from `http://localhost:5173` and `https://app.latentpresence.com` on 2026-09-14,
 * then the same calls from Chrome 152 (`docs/SURFACE.md`). The node live checks of P1-T02
 * and P1-T03 could never have shown any of it — node does not enforce CORS.
 *
 * - `direct`: the endpoint answers CORS for a page's origin, so the page calls it.
 * - `local-cors`: a server on the user's machine whose CORS is off, or limited, by default.
 *   The page calls it once the user turns CORS on; `corsHelp` says how.
 * - `relay`: the vendor sends no CORS headers at all, so no page can read its answers. The
 *   call goes through the companion's `/relay` on this machine (`relayFetch`).
 */
export type BrowserAccessKind = 'direct' | 'local-cors' | 'relay';

/** Steps a person follows to let this page reach an endpoint. */
export interface CorsHelp {
  /** One sentence: what is wrong, in the user's terms. */
  readonly summary: string;
  /** In order. A step may hold a command; the UI renders those in `code`. */
  readonly steps: readonly string[];
}

/** By preset id (`llmPresets`), plus the two native adapters. */
const ACCESS: Readonly<Record<string, BrowserAccessKind>> = {
  // Default origins: localhost, 127.0.0.1 and 0.0.0.0 on any port, plus app://, file://,
  // tauri:// (Ollama 0.34.0 source and a 403 for app.latentpresence.com and tauri.localhost).
  ollama: 'local-cors',
  // No CORS headers at all unless enabled (measured on a running server).
  'lm-studio': 'local-cors',
  // `--allowed-origins` defaults to ['*'] (vLLM docs). Not measured on a running server.
  vllm: 'direct',
  // `--cors-origins` defaults to * (llama.cpp README); localhost-only with --tools/--agent.
  'llama-cpp': 'direct',
  openrouter: 'direct',
  // No Access-Control-Allow-Origin on /v1/models or /v1/chat/completions, preflight or not.
  nvidia: 'relay',
  deepseek: 'direct',
  kimi: 'direct',
  // Only with `anthropic-dangerous-direct-browser-access: true`, which the adapter sends.
  anthropic: 'direct',
  google: 'direct',
};

/** How the page reaches an endpoint. A custom endpoint nobody has measured is `direct`
 * until a probe says otherwise — `probeEndpoint` tells a CORS refusal from a dead server. */
export function browserAccess(id: string): BrowserAccessKind {
  return ACCESS[id] ?? 'direct';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

/** True for an origin Ollama allows without `OLLAMA_ORIGINS`: http or https on a local
 * host, any port. */
export function ollamaAllowsByDefault(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * What to tell a person whose page at `origin` was refused by endpoint `id`, or null when
 * there is nothing they can change about CORS (a cloud endpoint that allows every origin
 * refused nothing; the failure is elsewhere).
 */
export function corsHelp(id: string, origin: string): CorsHelp | null {
  switch (id) {
    case 'ollama':
      if (ollamaAllowsByDefault(origin)) return null;
      return {
        summary: `Ollama only accepts pages on this computer by default, and this page is ${origin}.`,
        steps: [
          `Set the environment variable OLLAMA_ORIGINS to ${origin}`,
          'Windows: quit Ollama from the taskbar, search Settings for "environment variables", choose "Edit environment variables for your account", add OLLAMA_ORIGINS, then start Ollama from the Start menu.',
          `macOS: launchctl setenv OLLAMA_ORIGINS "${origin}" — then restart the Ollama app.`,
          'Linux (systemd): systemctl edit ollama.service, add Environment="OLLAMA_ORIGINS=' +
            origin +
            '" under [Service], then systemctl daemon-reload && systemctl restart ollama',
        ],
      };
    case 'lm-studio':
      return {
        summary: "LM Studio's server refuses web pages until CORS is turned on.",
        steps: [
          'In LM Studio, open the server settings and turn on "Enable CORS".',
          'Or start the server from a terminal: lms server start --cors',
        ],
      };
    case 'vllm':
      return {
        summary: 'vLLM allows every origin unless it was started with --allowed-origins.',
        steps: [`Restart vLLM with --allowed-origins '["${origin}"]', or without that flag.`],
      };
    case 'llama-cpp':
      return {
        summary: 'llama-server allows every origin unless --cors-origins, --tools or --agent narrowed it.',
        steps: [`Restart llama-server with --cors-origins ${origin}`],
      };
    case 'nvidia':
      return {
        summary: "NVIDIA's API does not answer web pages, so calls to it go through the companion on this computer.",
        steps: ['Start the companion: pnpm companion', 'Then test the connection again.'],
      };
    default:
      return null;
  }
}
