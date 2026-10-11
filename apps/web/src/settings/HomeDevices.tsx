import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { deviceKey, mayBeAuto, type HomeDevice, type ToolPolicy } from '@latentpresence/core';
import type { ToolsSettings } from './settings';

/**
 * Settings → Tools → Home Assistant devices (P5-T07, ADR-48): the room she is spoken to from, and
 * what she may do with each device. HA's tools name a device, an area or a domain rather than an
 * entity id, so a choice here belongs to the device, not to a tool. This only reads and writes
 * the settings; the gate in core decides what a call does with them.
 */
export interface HomeDevicesProps {
  readonly devices: readonly HomeDevice[];
  /** The key the server's grants are kept under, `companion:homeassistant`. */
  readonly serverId: string;
  readonly tools: ToolsSettings;
  readonly onChange: (update: (previous: ToolsSettings) => ToolsSettings) => void;
}

/** What she can act on. A sensor or a person is in her map of the home but is nothing to allow. */
export const CONTROLLABLE_DOMAINS: ReadonlySet<string> = new Set([
  'light',
  'switch',
  'fan',
  'cover',
  'lock',
  'climate',
  'media_player',
  'vacuum',
  'humidifier',
  'water_heater',
  'valve',
  'alarm_control_panel',
  'scene',
  'script',
  'button',
  'input_boolean',
  'todo',
  'siren',
  'lawn_mower',
]);

const POLICY_OPTIONS: readonly { readonly value: ToolPolicy; readonly text: string }[] = [
  { value: 'ask', text: 'Ask first' },
  { value: 'auto', text: 'Always allow' },
  { value: 'never', text: 'Never' },
];

function firstName(device: HomeDevice): string {
  return device.names[0] ?? '';
}

function compareDevices(a: HomeDevice, b: HomeDevice): number {
  const areaA = a.areas[0];
  const areaB = b.areas[0];
  // No area sorts last, so a room's devices are not buried under the ones HA never placed.
  if (areaA !== areaB) {
    if (areaA === undefined) return 1;
    if (areaB === undefined) return -1;
    const byArea = areaA.localeCompare(areaB);
    if (byArea !== 0) return byArea;
  }
  return firstName(a).localeCompare(firstName(b));
}

function matches(device: HomeDevice, needle: string): boolean {
  return [...device.names, ...device.areas].some((text) => text.toLowerCase().includes(needle));
}

export function HomeDevices({ devices, serverId, tools, onChange }: HomeDevicesProps): ReactElement {
  const [find, setFind] = useState('');
  const areaId = useId();
  const findId = useId();

  const controllable = devices.filter((device) => CONTROLLABLE_DOMAINS.has(device.domain));
  const listed = [...new Set(controllable.flatMap((device) => device.areas.slice(0, 1)))].toSorted((a, b) => a.localeCompare(b));
  // A saved room that HA no longer lists stays selectable, so opening Settings does not lose it.
  const areas = tools.homeArea !== null && !listed.includes(tools.homeArea) ? [...listed, tools.homeArea] : listed;

  const needle = find.trim().toLowerCase();
  const shown = controllable.filter((device) => needle === '' || matches(device, needle)).toSorted(compareDevices);

  function setArea(value: string): void {
    const homeArea = value === '' ? null : value;
    onChange((previous) => ({ ...previous, homeArea }));
  }

  function setPolicy(device: HomeDevice, policy: ToolPolicy): void {
    // A device's choice is about the device, not a tool's wording, so it carries no fingerprint.
    onChange((previous) => ({
      ...previous,
      grants: { ...previous.grants, [serverId]: { ...previous.grants[serverId], [deviceKey(device)]: { policy, fingerprint: null } } },
    }));
  }

  if (controllable.length === 0) {
    return (
      <div className="home-devices">
        <p className="panel-note">
          Home Assistant exposed no devices she can act on. Expose them in Home Assistant under Settings → Voice assistants → Expose, then press
          List again.
        </p>
      </div>
    );
  }

  return (
    <div className="home-devices">
      <div className="field">
        <label className="field-label" htmlFor={areaId}>
          Where you talk to her from
        </label>
        <select className="select" id={areaId} onChange={(event) => setArea(event.target.value)} value={tools.homeArea ?? ''}>
          <option value="">Not set</option>
          {areas.map((area) => (
            <option key={area} value={area}>
              {area}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={findId}>
          Find a device
        </label>
        <input className="input" id={findId} onChange={(event) => setFind(event.target.value)} spellCheck={false} type="search" value={find} />
      </div>

      {shown.length === 0 ? (
        <p className="panel-note">No device matches that.</p>
      ) : (
        <ul className="tools-tool-list">
          {shown.map((device, index) => {
            const auto = mayBeAuto(device);
            const saved = tools.grants[serverId]?.[deviceKey(device)]?.policy ?? 'ask';
            // The core never lets a lock be auto, so a stale entry is shown as what it will do.
            const policy = !auto && saved === 'auto' ? 'ask' : saved;
            const area = device.areas[0];
            return (
              <li className="tools-tool" key={`${deviceKey(device)}:${index}`}>
                <div className="tools-tool-head">
                  <div className="home-device-title">
                    <span className="home-device-names">{device.names.join(' / ')}</span>
                    <span className="home-device-meta">{area === undefined ? device.domain : `${area} · ${device.domain}`}</span>
                  </div>
                  <select
                    aria-label={`Policy for ${firstName(device)}`}
                    className="select"
                    onChange={(event) => setPolicy(device, event.target.value as ToolPolicy)}
                    value={policy}
                  >
                    {POLICY_OPTIONS.map((option) => (
                      <option disabled={option.value === 'auto' && !auto} key={option.value} value={option.value}>
                        {option.text}
                      </option>
                    ))}
                  </select>
                </div>
                {!auto && <p className="home-device-note">Always asks: it can unlock, open or disarm.</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
