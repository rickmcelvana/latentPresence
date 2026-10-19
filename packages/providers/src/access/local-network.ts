import type { CorsHelp } from './browser-access';

/**
 * Browsers' local network access (P8-T03, ADR-64).
 *
 * A page on a public site (the hosted app) that calls this computer — the companion, Ollama, LM
 * Studio — or a device on the LAN needs the person's permission first. Measured 2026-10-19 in
 * Chrome 155 and Firefox 154 (`docs/SURFACE.md`):
 * - the permissions are `loopback-network` (this computer: Chrome's site setting "Apps on
 *   device", Firefox's "Device apps and services") and `local-network` (the LAN). Older Chrome
 *   knows only the combined `local-network-access`; Firefox does not know that name at all.
 * - **while the prompt is up, the request waits**; **once denied it fails like a server that is
 *   not there**. Only the permission's state tells the person which it was.
 * - no `targetAddressSpace` is needed for `http://127.0.0.1` or `http://localhost`, and there is
 *   no mixed-content error once granted.
 */

export type AddressSpace = 'loopback' | 'local' | 'public';

/** The part of `localNetworkPermission` this needs; `navigator.permissions` fits. */
export interface PermissionsLike {
  query(descriptor: { name: string }): Promise<{ readonly state: string }>;
}

export type LocalNetworkState = 'granted' | 'prompt' | 'denied';

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return numbers.every((n) => n >= 0 && n <= 255) ? numbers : null;
}

/** Where a URL's host is, as browsers see it; null when it does not parse. */
export function addressSpaceOf(url: string): AddressSpace | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0') return 'loopback';
  const v4 = ipv4(host);
  if (v4 !== null) {
    const [a = 0, b = 0] = v4;
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'local';
    return 'public';
  }
  if (host.endsWith('.local')) return 'local';
  if (host.startsWith('[')) return /^\[(fc|fd|fe[89ab])/.test(host) ? 'local' : 'public';
  return 'public';
}

const RANK: Record<AddressSpace, number> = { public: 0, local: 1, loopback: 2 };

/** The permission a page at `pageOrigin` needs to call `url`, or null when it needs none: only a
 * request into a more private space than the page's own is asked about. */
export function localNetworkNeeded(pageOrigin: string, url: string): 'loopback' | 'local' | null {
  const page = addressSpaceOf(pageOrigin);
  const target = addressSpaceOf(url);
  if (page === null || target === null || target === 'public') return null;
  return RANK[target] > RANK[page] ? target : null;
}

/** The person's answer so far for `space`, or null when this browser does not ask. */
export async function localNetworkPermission(space: 'loopback' | 'local', permissions: PermissionsLike | null | undefined): Promise<LocalNetworkState | null> {
  if (permissions === null || permissions === undefined) return null;
  for (const name of [space === 'loopback' ? 'loopback-network' : 'local-network', 'local-network-access']) {
    try {
      const { state } = await permissions.query({ name });
      if (state === 'granted' || state === 'prompt' || state === 'denied') return state;
    } catch {
      // Not a permission this browser knows; try the older combined name.
    }
  }
  return null;
}

const SETTING = {
  loopback: { chrome: 'Apps on device', firefox: 'Device apps and services', what: 'apps on this computer' },
  local: { chrome: 'Local network', firefox: 'Local network devices', what: 'devices on your network' },
} as const;

/** What to tell the person when the browser is asking, or has been told no. */
export function localNetworkHelp(state: 'prompt' | 'denied', space: 'loopback' | 'local'): CorsHelp {
  const setting = SETTING[space];
  if (state === 'prompt') {
    return {
      summary: `Your browser is asking whether this site may reach ${setting.what}. Choose Allow, then try again.`,
      steps: [
        `Chrome and Edge show it under the address bar ("${setting.chrome}"); Firefox shows it beside the address ("${setting.firefox}").`,
        'No prompt in sight? Reload the page and try again.',
      ],
    };
  }
  return {
    summary: `Your browser is blocking this site from reaching ${setting.what}.`,
    steps: [
      `Chrome or Edge: click the icon at the left of the address bar, then Site settings, and set "${setting.chrome}" to Allow.`,
      `Firefox: click the crossed-out icon in the address bar and clear the block on "${setting.firefox}", or Settings → Privacy & Security → Permissions → ${setting.firefox}.`,
      'Then reload the page.',
    ],
  };
}
