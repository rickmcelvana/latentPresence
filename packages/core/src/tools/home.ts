import type { JsonObject } from '@latentpresence/protocol';
import type { ToolGrant } from './gate';

/**
 * Home Assistant (P5-T07, ADR-48): her map of the home, and who decides each action.
 *
 * **HA's tools target by name, area, floor and domain, never by entity id** — and
 * `intent__HassTurnOn` is the kitchen light and the front-door lock alike (HA's turn-on locks a
 * lock, its turn-off unlocks it). So a grant per tool cannot say "the kitchen light may, the
 * lock may not": actions are decided per device, from the call's own arguments, before it runs.
 */

/** One device as HA's "Assist" prompt lists it: its names (aliases replace the name), domain, areas. */
export interface HomeDevice {
  readonly names: readonly string[];
  readonly domain: string;
  readonly areas: readonly string[];
}

/**
 * What unlocks, opens or disarms: always asked, never auto. A garage door is a `cover`, and HA's
 * overview does not say which covers are doors, so every cover asks.
 */
export const ALWAYS_ASK_DOMAINS: ReadonlySet<string> = new Set(['lock', 'alarm_control_panel', 'cover', 'valve']);

/** Reading tools keep the ordinary per-tool gate: `GetLiveContext`, `GetDateTime`, `get_items`. */
const READING = /__(?:Hass)?Get[A-Z]\w*$|__get_\w+$/u;

export function isReadingTool(tool: string): boolean {
  return READING.test(tool);
}

/** Where a device's grant is kept among the server's tool grants: never a tool name. */
export function deviceKey(device: HomeDevice): string {
  return `device:${(device.names[0] ?? '').toLowerCase()}`;
}

/** Whether the person may set a device to auto at all. */
export function mayBeAuto(device: HomeDevice): boolean {
  return !ALWAYS_ASK_DOMAINS.has(device.domain);
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function list(value: string): string[] {
  return value
    .split(', ')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * The devices in HA's "Assist" prompt, from the YAML after "Static Context": a list of mappings,
 * `names` and `areas` joined with ", ", a long value folded onto the next line. Nothing parsed
 * is an empty list, never a throw — the text is HA's and may change.
 */
export function parseHomeOverview(text: string): HomeDevice[] {
  const start = text.indexOf('Static Context');
  if (start < 0) return [];
  const lines = text.slice(start).split('\n').slice(1);
  const devices: HomeDevice[] = [];
  let current: Record<string, string> | null = null;
  let last: string | null = null;
  const finish = (): void => {
    if (current === null) return;
    const names = list(unquote(current['names'] ?? ''));
    const domain = unquote(current['domain'] ?? '');
    if (names.length > 0 && domain !== '') devices.push({ names, domain, areas: list(unquote(current['areas'] ?? '')) });
    current = null;
    last = null;
  };
  for (const line of lines) {
    if (line.trim() === '') {
      if (devices.length > 0 || current !== null) break;
      continue;
    }
    const item = /^- (\w+):(.*)$/u.exec(line);
    const field = /^ {2}(\w+):(.*)$/u.exec(line);
    if (item !== null) {
      finish();
      current = { [item[1]!]: item[2]! };
      last = item[1]!;
    } else if (field !== null && current !== null) {
      current[field[1]!] = field[2]!;
      last = field[1]!;
    } else if (/^ {3,}\S/u.test(line) && current !== null && last !== null) {
      current[last] = `${current[last] ?? ''} ${line.trim()}`;
    } else {
      break;
    }
  }
  finish();
  return devices;
}

/** The device a call names, by any of its names, ignoring case. */
export function findDevice(devices: readonly HomeDevice[], name: string): HomeDevice | undefined {
  const wanted = name.trim().toLowerCase();
  return devices.find((device) => device.names.some((candidate) => candidate.toLowerCase() === wanted));
}

function strings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

/** What a call reaches, in words for the card: the device, or every device that matches. */
export function homeTarget(args: JsonObject, device: HomeDevice | undefined): string {
  if (device !== undefined) return device.areas.length > 0 ? `${device.names[0]} (${device.areas[0]})` : device.names[0]!;
  const named = strings(args['name'])[0];
  if (named !== undefined) return `${named} (not in Home Assistant's list)`;
  const kinds = strings(args['domain']);
  const what = kinds.length === 0 ? 'every device' : `every ${kinds.join(' and ')}`;
  const where = strings(args['area'])[0] ?? strings(args['floor'])[0];
  return where === undefined ? `${what} that matches, anywhere in the home` : `${what} in ${where}`;
}

export type HomeVerdict =
  /** A reading tool: the ordinary per-tool gate decides. */
  | { readonly kind: 'tool' }
  | { readonly kind: 'auto'; readonly target: string }
  | { readonly kind: 'never'; readonly target: string }
  /** `device` is what "Always allow" would set to auto; null when it may not be offered. */
  | { readonly kind: 'ask'; readonly target: string; readonly device: HomeDevice | null };

/**
 * The devices an area-and-domain call reaches, from HA's overview — HA's own prompt tells a model
 * to turn "the light" in a room on that way. Only for domains that may be auto, and only with
 * both given: a floor, a bare area or a lock is never worked out here, so a device the overview
 * has not caught up with can only be one more light, never a door.
 */
export function areaDevices(args: JsonObject, devices: readonly HomeDevice[]): HomeDevice[] {
  const area = strings(args['area'])[0]?.toLowerCase();
  const domains = strings(args['domain']);
  if (area === undefined || domains.length === 0 || strings(args['floor']).length > 0) return [];
  if (domains.some((domain) => ALWAYS_ASK_DOMAINS.has(domain))) return [];
  return devices.filter((device) => domains.includes(device.domain) && device.areas.some((name) => name.toLowerCase() === area));
}

function decideDevice(device: HomeDevice, target: string, grant: (key: string) => ToolGrant | undefined): HomeVerdict {
  const policy = grant(deviceKey(device))?.policy ?? 'ask';
  if (policy === 'never') return { kind: 'never', target };
  if (!mayBeAuto(device)) return { kind: 'ask', target, device: null };
  return policy === 'auto' ? { kind: 'auto', target } : { kind: 'ask', target, device };
}

/**
 * Who decides this call. A named device follows its own grant (ask by default); so does a room's
 * one light asked for by area. Several devices run by themselves only if every one is auto; any
 * other call that names no device asks; a lock, alarm, cover or valve always asks.
 */
export function homeVerdict(
  tool: string,
  args: JsonObject,
  devices: readonly HomeDevice[],
  grant: (key: string) => ToolGrant | undefined,
): HomeVerdict {
  if (isReadingTool(tool)) return { kind: 'tool' };
  const name = strings(args['name'])[0];
  if (name !== undefined) {
    const device = findDevice(devices, name);
    const target = homeTarget(args, device);
    return device === undefined ? { kind: 'ask', target, device: null } : decideDevice(device, target, grant);
  }
  const reached = areaDevices(args, devices);
  if (reached.length === 1) return decideDevice(reached[0]!, homeTarget(args, reached[0]), grant);
  const target = reached.length === 0 ? homeTarget(args, undefined) : `${homeTarget(args, undefined)}: ${reached.map((device) => device.names[0]).join(', ')}`;
  const policies = reached.map((device) => grant(deviceKey(device))?.policy ?? 'ask');
  if (reached.length > 1 && policies.every((policy) => policy === 'auto')) return { kind: 'auto', target };
  return { kind: 'ask', target, device: null };
}
