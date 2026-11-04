import { cleanup, render, screen, within } from '@testing-library/react';
import { REGISTRY } from '@latentpresence/ml-web/registry/catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { expectAccessible } from '../test/axe';
import { PrivacyPage } from './PrivacyPage';

describe('PrivacyPage', () => {
  afterEach(cleanup);

  it('says the promise, and that nothing is reported', () => {
    render(<PrivacyPage />);
    expect(screen.getByText('Nothing leaves your machine unless you point it somewhere.')).toBeTruthy();
    expect(screen.getByText(/no telemetry/u)).toBeTruthy();
  });

  it('lists every model in the registry and both bodies, each with its licence', () => {
    const { container } = render(<PrivacyPage />);
    const rows = [...container.querySelectorAll('.registry-entry')] as HTMLElement[];
    expect(rows).toHaveLength(REGISTRY.length + 2);
    for (const entry of REGISTRY) {
      const row = rows.find((candidate) => candidate.textContent?.includes(entry.name));
      expect(row, entry.name).toBeDefined();
      expect(within(row as HTMLElement).getByText(new RegExp(entry.licence.replace(/[()]/gu, '.'), 'u'))).toBeTruthy();
    }
    for (const row of rows.slice(-2)) expect(row.textContent).toContain('VRM Public License 1.0');
    expect(rows.at(-1)?.textContent).toContain('pixiv VRoid Project');
  });

  it('shows a hash for every file, with the pinned commit', () => {
    const { container } = render(<PrivacyPage />);
    const hashes = [...container.querySelectorAll('.registry-file-hash')];
    expect(hashes.length).toBeGreaterThan(90);
    for (const hash of hashes) expect(hash.textContent).toMatch(/^[0-9a-f]{64}$/u);
    expect(container.textContent).toContain('pinned to dd4401a9a');
  });

  it('links each download back to its source and to where it can be deleted', () => {
    render(<PrivacyPage />);
    expect(screen.getByRole('link', { name: 'Settings, Downloaded models' }).getAttribute('href')).toBe('/settings');
    for (const link of screen.getAllByRole('link', { name: 'source' })) expect(link.getAttribute('href')).toMatch(/^https:\/\//u);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<PrivacyPage />);
    await expectAccessible(container);
  });
});
