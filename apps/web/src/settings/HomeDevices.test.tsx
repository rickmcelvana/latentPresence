import { useState } from 'react';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HomeDevice } from '@latentpresence/core';
import { HomeDevices } from './HomeDevices';
import type { ToolsSettings } from './settings';

afterEach(cleanup);

const SERVER = 'companion:homeassistant';

const DEVICES: HomeDevice[] = [
  { names: ['Kitchen Lights', 'Cooker light'], domain: 'light', areas: ['Kitchen'] },
  { names: ['Garage Door'], domain: 'cover', areas: ['Garage'] },
  { names: ['Front Door'], domain: 'lock', areas: ['Hall'] },
  { names: ['Desk Lamp'], domain: 'light', areas: [] },
  { names: ['Bedroom Fan'], domain: 'fan', areas: ['Bedroom'] },
  { names: ['Outside Temperature'], domain: 'sensor', areas: [] },
];

const EMPTY: ToolsSettings = { servers: [], grants: {}, companion: true, homeArea: null };

function mount(devices: HomeDevice[], initial: ToolsSettings = EMPTY): { latest: () => ToolsSettings } {
  let latest = initial;
  function Host(): ReactElement {
    const [tools, setTools] = useState(initial);
    return (
      <HomeDevices
        devices={devices}
        onChange={(update) =>
          setTools((previous) => {
            latest = update(previous);
            return latest;
          })
        }
        serverId={SERVER}
        tools={tools}
      />
    );
  }
  render(<Host />);
  return { latest: () => latest };
}

describe('HomeDevices', () => {
  it('lists only what she can act on, by area then name, with the area last when there is none', () => {
    mount(DEVICES);
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('Bedroom Fan');
    expect(rows[1]).toContain('Garage Door');
    expect(rows[2]).toContain('Front Door');
    expect(rows[3]).toContain('Kitchen Lights / Cooker light');
    expect(rows[4]).toContain('Desk Lamp');
    expect(screen.queryByText(/Outside Temperature/)).toBeNull();
  });

  it('offers Not set and the listed areas, sorted, and writes the one chosen', () => {
    const { latest } = mount(DEVICES);
    const select = screen.getByLabelText('Where you talk to her from') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Not set', 'Bedroom', 'Garage', 'Hall', 'Kitchen']);
    fireEvent.change(select, { target: { value: 'Kitchen' } });
    expect(latest().homeArea).toBe('Kitchen');
    fireEvent.change(select, { target: { value: '' } });
    expect(latest().homeArea).toBeNull();
  });

  it('keeps a saved area that Home Assistant no longer lists', () => {
    mount(DEVICES, { ...EMPTY, homeArea: 'Attic' });
    const select = screen.getByLabelText('Where you talk to her from') as HTMLSelectElement;
    expect(select.value).toBe('Attic');
    expect([...select.options].map((option) => option.textContent)).toContain('Attic');
  });

  it('writes a device grant with no fingerprint, and leaves its other grants alone', () => {
    const { latest } = mount(DEVICES, {
      ...EMPTY,
      grants: { [SERVER]: { 'device:bedroom fan': { policy: 'never', fingerprint: null } }, other: { x: { policy: 'ask', fingerprint: null } } },
    });
    const select = screen.getByRole('combobox', { name: 'Policy for Kitchen Lights' }) as HTMLSelectElement;
    expect(select.value).toBe('ask');
    fireEvent.change(select, { target: { value: 'auto' } });
    expect(latest().grants[SERVER]).toEqual({
      'device:bedroom fan': { policy: 'never', fingerprint: null },
      'device:kitchen lights': { policy: 'auto', fingerprint: null },
    });
    expect(latest().grants['other']).toEqual({ x: { policy: 'ask', fingerprint: null } });
    expect((screen.getByRole('combobox', { name: 'Policy for Bedroom Fan' }) as HTMLSelectElement).value).toBe('never');
  });

  it('does not offer Always allow for what can unlock, open or disarm, and says why', () => {
    mount(DEVICES);
    for (const name of ['Garage Door', 'Front Door']) {
      const select = screen.getByRole('combobox', { name: `Policy for ${name}` });
      expect((within(select).getByRole('option', { name: 'Always allow' }) as HTMLOptionElement).disabled).toBe(true);
      expect((within(select).getByRole('option', { name: 'Never' }) as HTMLOptionElement).disabled).toBe(false);
    }
    const light = screen.getByRole('combobox', { name: 'Policy for Kitchen Lights' });
    expect((within(light).getByRole('option', { name: 'Always allow' }) as HTMLOptionElement).disabled).toBe(false);
    expect(screen.getAllByText(/can unlock, open or disarm/)).toHaveLength(2);
  });

  it('shows a stale auto on a lock as Ask first, which is what the gate will do', () => {
    mount(DEVICES, { ...EMPTY, grants: { [SERVER]: { 'device:front door': { policy: 'auto', fingerprint: null } } } });
    expect((screen.getByRole('combobox', { name: 'Policy for Front Door' }) as HTMLSelectElement).value).toBe('ask');
  });

  it('finds a device by any of its names or by its area, ignoring case', () => {
    mount(DEVICES);
    const find = screen.getByLabelText('Find a device');
    fireEvent.change(find, { target: { value: 'COOKER' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Policy for Kitchen Lights' })).toBeTruthy();
    fireEvent.change(find, { target: { value: 'garage' } });
    expect(screen.getByRole('combobox', { name: 'Policy for Garage Door' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(find, { target: { value: 'zzz' } });
    expect(screen.getByText('No device matches that.')).toBeTruthy();
  });

  it('says where to expose devices when there are none she can act on', () => {
    mount([DEVICES[5]!]);
    expect(screen.getByText(/exposed no devices/)).toBeTruthy();
    expect(screen.getByText(/Settings → Voice assistants → Expose/)).toBeTruthy();
    expect(screen.queryByLabelText('Where you talk to her from')).toBeNull();
  });
});
