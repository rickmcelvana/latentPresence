import type { EndpointProbe } from '@latentpresence/providers/web';

/**
 * Why a tool server's Test failed, in words a person can act on (P8-T06, R-57's follow-up).
 *
 * The MCP client's own error says little ("Failed to fetch"), and Rick read it as "not up" for a
 * Home Assistant that was up: it answered, and refused the page — Home Assistant sends no CORS
 * headers to a page it was not told about (a 403 preflight for `http://tauri.localhost` and
 * `http://localhost:5173`, 2026-10-17). A second, plain probe of the address tells the cases
 * apart; this turns its answer into the sentence.
 */
export interface ToolServerFailureContext {
  readonly url: string;
  /** The MCP client's own message, kept for the cases the probe cannot explain. */
  readonly detail: string;
  readonly probe: EndpointProbe;
  /** The page's origin, named when a server refuses it. */
  readonly origin: string;
  /** The desktop app, which has a Home Assistant section and the companion's own list. */
  readonly inApp: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Home Assistant's MCP endpoint is `/api/mcp`, and 8123 its usual port. */
export function looksLikeHomeAssistant(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, '').endsWith('/api/mcp') || parsed.port === '8123' || /homeassistant/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function describeToolServerFailure({ url, detail, probe, origin, inApp }: ToolServerFailureContext): string {
  const host = hostOf(url);
  switch (probe.kind) {
    case 'cors-blocked': {
      const refused = `${host} is running, but it does not let this ${inApp ? 'app' : 'page'} connect to it directly.`;
      if (looksLikeHomeAssistant(url)) {
        return inApp
          ? `${refused} This looks like Home Assistant: connect it under Settings → Home Assistant instead. The app reaches it for you, and nothing needs changing in Home Assistant.`
          : `${refused} This looks like Home Assistant: put it in the companion's mcp.json as homeAssistant (the companion reaches it for you), or allow ${origin} in Home Assistant's http: cors_allowed_origins.`;
      }
      return inApp
        ? `${refused} A server on your own network can usually be added to the companion's list instead (Settings → Programs → Open mcp.json), or allowed to answer ${origin} in its own settings.`
        : `${refused} It would have to allow ${origin} (its CORS settings), or be listed in the companion's mcp.json instead.`;
    }
    case 'unreachable':
      return `Nothing answered at ${host}. Check the address, and that this computer can reach it.`;
    case 'timeout':
      return `${host} did not answer within 5 seconds.`;
    case 'answered':
      // The probe carries no token, so only the client's own error can say the token was refused.
      if (/\b(401|403)\b/.test(detail)) return `${host} answered and refused the token. Check that it is a token this server accepts, then save it again.`;
      if (probe.status === 404) return `A server answered at ${host}, but there is no MCP endpoint at this address. Check the path after the host.`;
      return `${host} answered, but the connection did not work: ${detail}`;
  }
}
