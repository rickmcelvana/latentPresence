import type { LlmFinishReason, LlmStreamChunk } from '@latentpresence/protocol';
import {
  browserAccess,
  corsHelp,
  localNetworkHelp,
  normaliseBaseUrl,
  probeEndpoint,
  relayFetch,
  type CorsHelp,
  type EndpointProbe,
  type HttpFetch,
} from '@latentpresence/providers/web';

/**
 * Test-connection decision logic (P1-T10).
 *
 * `messageForProbe` and `resolveTransport` are pure enough to table-test: the button in
 * `LanguageModelSection.tsx` and the server forms in `VoiceSection.tsx` /
 * `HearingSection.tsx` call them and render what comes back, but decide nothing of their
 * own. No function here performs a network call itself beyond the `probe`/`fetch`
 * passed in, so a test can inject both and never touch the network.
 */

export type ConnectionTone = 'ok' | 'warn' | 'danger';

/** What to show the user after a probe: a tone for the pill, the message, and — only for
 * a CORS refusal with something to say — the steps to fix it. */
export interface ConnectionResult {
  readonly tone: ConnectionTone;
  readonly text: string;
  readonly help?: CorsHelp;
}

/** What `messageForProbe` needs to know beyond the probe's own answer. */
export interface ProbeContext {
  /** Preset id, `'anthropic'`, `'google'`, or `'custom'`. */
  readonly endpointId: string;
  /** Human-facing name, for "Is <label> running?". */
  readonly label: string;
  /** The URL that was probed, for messages that name it. */
  readonly url: string;
  /** `window.location.origin`, passed through to `corsHelp`. */
  readonly origin: string;
  /** Whether a key is saved for this endpoint, so a bare 403 can say "needs a key"
   * instead of "was refused". */
  readonly hasKey: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** True for `localhost`, `127.0.0.1`, `0.0.0.0` or `[::1]`, whatever the port. */
export function isLocalHost(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Endpoints whose model listing answers a bad, or absent, key with 200 — so "Connected"
 * on its own would be a lie a completion could still contradict. */
const KEY_CHECKED_ON_USE = new Set(['nvidia', 'openrouter']);

/** Turn one `EndpointProbe` into the one message the brief's table specifies. Pure: same
 * inputs, same answer, every time — the shape a table test wants. */
export function messageForProbe(probe: EndpointProbe, ctx: ProbeContext): ConnectionResult {
  switch (probe.kind) {
    case 'answered':
      return messageForStatus(probe.status, ctx);
    case 'cors-blocked': {
      const help = corsHelp(ctx.endpointId, ctx.origin);
      if (help !== null) return { tone: 'warn', text: help.summary, help };
      return {
        tone: 'warn',
        text: `The server is running but does not allow this page (${ctx.origin}). Allow that origin in its CORS settings.`,
      };
    }
    case 'unreachable':
      return isLocalHost(ctx.url)
        ? { tone: 'danger', text: `Nothing is answering at ${ctx.url}. Is ${ctx.label} running?` }
        : { tone: 'danger', text: `Could not reach ${hostOf(ctx.url)}. Check the address and your connection.` };
    case 'timeout':
      return { tone: 'danger', text: `No answer within 5 seconds from ${ctx.url}.` };
    case 'browser-asking':
    case 'browser-blocked': {
      const help = localNetworkHelp(probe.kind === 'browser-asking' ? 'prompt' : 'denied', probe.space);
      return { tone: probe.kind === 'browser-asking' ? 'warn' : 'danger', text: help.summary, help };
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** True when the URL's path has an API version segment: `/v1`, `/api/v1`, `/v1beta/openai`. */
function hasVersionSegment(url: string): boolean {
  try {
    return /\/v\d[^/]*(\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * A 404 means a server answered, just not with an OpenAI-compatible listing — never
 * "nothing here". Without a version segment the base URL is the likely mistake; with one,
 * the server most likely has an API of its own (Voicebox 0.5.0 serves `/generate` and no
 * `/v1` at all, 2026-10-14).
 */
function messageForNotFound(url: string): ConnectionResult {
  const host = hostOf(url);
  if (!hasVersionSegment(url)) {
    return { tone: 'danger', text: `A server is running at ${host}, but not an OpenAI-compatible API at this path. The base URL usually ends in /v1.` };
  }
  return {
    tone: 'danger',
    text: `A server is running at ${host}, but it has no OpenAI-compatible API at this address. It may only offer an API of its own, which this setting cannot use.`,
  };
}

function messageForStatus(status: number, ctx: ProbeContext): ConnectionResult {
  if (status >= 200 && status < 300) {
    const caveat = KEY_CHECKED_ON_USE.has(ctx.endpointId)
      ? ' The key is checked when you send a test message.'
      : '';
    return { tone: 'ok', text: `Connected.${caveat}` };
  }
  const keyRefused = status === 401 || status === 403 || (status === 400 && ctx.endpointId === 'google');
  if (keyRefused) {
    if (status === 403 && !ctx.hasKey) return { tone: 'warn', text: 'This endpoint needs a key.' };
    return { tone: 'danger', text: 'The key was refused.' };
  }
  if (status === 404) return messageForNotFound(ctx.url);
  return { tone: 'danger', text: `The server answered ${status}.` };
}

/** The companion answered 401 to a page that is not on this computer (ADR-64). */
export const COMPANION_NEEDS_PAIRING =
  'The companion is running and needs its pairing code before it answers this site. Enter it under Settings → Companion: the companion prints it when it starts.';

/** Either a working transport to probe and call the endpoint with, or the reason there
 * is none — a `relay` endpoint whose companion is not answering. */
export type Transport = { readonly ok: true; readonly fetch: HttpFetch } | { readonly ok: false; readonly result: ConnectionResult };

export interface ResolveTransportOptions {
  readonly endpointId: string;
  readonly companionUrl: string;
  readonly origin: string;
  readonly fetch?: HttpFetch;
  readonly probe?: typeof probeEndpoint;
}

/**
 * The fetch a test, or a real call, should use for `endpointId`. Direct and `local-cors`
 * endpoints get the plain fetch straight back; a `relay` endpoint (NVIDIA, ADR-29) is
 * probed at `${companionUrl}/health` first — not `answered` 200 means "start the
 * companion", surfaced as `corsHelp`'s own wording, and no further call is made.
 */
export async function resolveTransport(options: ResolveTransportOptions): Promise<Transport> {
  const fetchFn = options.fetch ?? fetch;
  if (browserAccess(options.endpointId) !== 'relay') return { ok: true, fetch: fetchFn };

  const probe = options.probe ?? probeEndpoint;
  const health = await probe(`${normaliseBaseUrl(options.companionUrl)}/health`, { fetch: fetchFn });
  if (health.kind === 'answered' && health.status === 200) {
    return { ok: true, fetch: relayFetch(options.companionUrl, fetchFn) };
  }
  // ADR-64: running, and waiting for its pairing code — or the browser stopped the request.
  if (health.kind === 'answered' && health.status === 401) {
    return { ok: false, result: { tone: 'warn', text: COMPANION_NEEDS_PAIRING } };
  }
  if (health.kind === 'browser-asking' || health.kind === 'browser-blocked') {
    return { ok: false, result: messageForProbe(health, { endpointId: 'companion', label: 'the companion', url: options.companionUrl, origin: options.origin, hasKey: false }) };
  }
  const help = corsHelp(options.endpointId, options.origin);
  return {
    ok: false,
    result: {
      tone: 'warn',
      text: help?.summary ?? 'The companion is not answering.',
      ...(help === null ? {} : { help }),
    },
  };
}

/** `GET {baseUrl}/models` request pieces for any OpenAI-compatible endpoint. */
export function openAiCompatibleListing(baseUrl: string, apiKey: string | null): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  if (apiKey !== null) headers['authorization'] = `Bearer ${apiKey}`;
  return { url: `${normaliseBaseUrl(baseUrl)}/models`, headers };
}

export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';

/** `GET /v1/models` request pieces for native Anthropic. */
export function anthropicListing(apiKey: string | null): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (apiKey !== null) headers['x-api-key'] = apiKey;
  return { url: ANTHROPIC_MODELS_URL, headers };
}

export const GOOGLE_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** `GET /v1beta/models` request pieces for native Google. */
export function googleListing(apiKey: string | null): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  if (apiKey !== null) headers['x-goog-api-key'] = apiKey;
  return { url: GOOGLE_MODELS_URL, headers };
}

/** The result of sending the test message (below). */
export type TestMessageOutcome = 'replied' | 'no-output' | 'error';

export interface TestMessageResult {
  readonly outcome: TestMessageOutcome;
  /** Text streamed back, if any — reasoning deltas are never included. */
  readonly text: string;
  readonly seconds: number;
  /** The one line the panel shows. */
  readonly message: string;
}

function messageFor(outcome: TestMessageOutcome, seconds: number, finishReason: LlmFinishReason | null, error: string | null): string {
  if (outcome === 'replied') return `Replied in ${seconds.toFixed(1)} s`;
  if (outcome === 'error') {
    return error ?? (finishReason === 'error' ? 'The model reported an error.' : 'Something went wrong.');
  }
  if (finishReason === 'length') {
    return 'The model spent its whole output budget thinking and wrote nothing. Pick a non-thinking model, or one with a larger output limit.';
  }
  return 'The model gave no reply.';
}

/**
 * Consume a model's stream and turn it into one of the three outcomes the brief
 * specifies. `now` is injected so a test can fake elapsed time without a real clock.
 * Reasoning deltas are read (so a thinking model's `finish` is still reached) but never
 * added to `text` — the reply is what would be spoken, not the model's scratch work.
 */
export async function runTestMessage(
  stream: AsyncIterable<LlmStreamChunk>,
  now: () => number = () => Date.now(),
  onDelta?: (textSoFar: string) => void,
): Promise<TestMessageResult> {
  const start = now();
  let text = '';
  let finishReason: LlmFinishReason | null = null;
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
        onDelta?.(text);
      }
      if (chunk.type === 'finish') finishReason = chunk.reason;
    }
  } catch (error) {
    const seconds = (now() - start) / 1000;
    const errorText = error instanceof Error ? error.message : String(error);
    return { outcome: 'error', text, seconds, message: messageFor('error', seconds, finishReason, errorText) };
  }

  const seconds = (now() - start) / 1000;
  if (text.length > 0) return { outcome: 'replied', text, seconds, message: messageFor('replied', seconds, finishReason, null) };
  if (finishReason === 'error') return { outcome: 'error', text, seconds, message: messageFor('error', seconds, finishReason, null) };
  return { outcome: 'no-output', text, seconds, message: messageFor('no-output', seconds, finishReason, null) };
}
