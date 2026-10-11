import type { PromptContext, PromptContextInput } from '@latentpresence/protocol';
import type { HomeDevice } from '../tools/home';

/**
 * Her prompt's home section (P5-T07, ADR-48): what she can work, by area, and where they are.
 *
 * HA matches a device by its exact name or alias, and a whole room by area and domain (its own
 * prompt says so), so she is handed the names as HA has them. A large home is cut: the live
 * context tool finds the rest.
 */

/** Enough for a real home's lights and switches; past it she asks GetLiveContext. */
export const HOME_PROMPT_DEVICES = 150;

/** `PromptContext['home']`, read-only, so core's own `HomeDevice` list passes as it is. */
interface Home {
  readonly devices: readonly { readonly names: readonly string[]; readonly domain: string; readonly areas: readonly string[] }[];
  readonly area: NonNullable<PromptContext['home']>['area'];
}

/** The prompt context for a home: copies, within the contract's limits. */
export function homeContext(devices: readonly HomeDevice[], area: string | null): NonNullable<PromptContextInput['home']> {
  return {
    devices: devices.slice(0, 1000).map((device) => ({ names: device.names.slice(0, 8), domain: device.domain, areas: device.areas.slice(0, 8) })),
    area,
  };
}

export function renderHome(home: Home): string[] {
  const shown = home.devices.slice(0, HOME_PROMPT_DEVICES);
  const byArea = new Map<string, string[]>();
  for (const device of shown) {
    const area = device.areas[0] ?? '';
    const names = device.names.join(' or ');
    byArea.set(area, [...(byArea.get(area) ?? []), `${names} (${device.domain})`]);
  }
  const areas = [...byArea.keys()].filter((area) => area !== '').toSorted((a, b) => a.localeCompare(b));
  const rest = home.devices.length - shown.length;
  return [
    'THEIR HOME',
    '- You can work their home with the Home Assistant tools. For one device, give its exact',
    '  name from the list below and its domain; for a whole room, give the area and the domain.',
    '  Never make up a name that is not listed.',
    ...(home.area === null
      ? []
      : [`- They are talking to you from the ${home.area}. "The light" or "in here" means the ${home.area}'s.`]),
    '- Say it is done only once the tool says so, in a few words, and never read out a domain.',
    '- What is there, by area:',
    ...areas.map((area) => `  ${area}: ${byArea.get(area)!.join(', ')}`),
    ...(byArea.has('') ? [`  No area: ${byArea.get('')!.join(', ')}`] : []),
    ...(rest > 0 ? [`  And ${rest} more: GetLiveContext finds them by name, area or domain.`] : []),
    '',
  ];
}
