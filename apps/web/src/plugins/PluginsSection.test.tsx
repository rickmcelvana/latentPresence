import { useState, type ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeMemoryStore } from '@latentpresence/core';
import type { PluginManifestInput } from '@latentpresence/protocol';
import { expectAccessible } from '../test/axe';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings';
import { PluginAssets } from './assets';
import { pageSha256 } from './inspect';
import { PluginsSection, type PluginsDeps } from './PluginsSection';
import { InMemoryPluginShelf } from './shelf';

afterEach(cleanup);

/** Settings → Plugins (P10-T03): read from an address, the consent screen, install, per character, settings, remove. */

const encode = (text: string) => new TextEncoder().encode(text);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const BASE = 'https://plugins.example.com/sky/';

async function served(edit: (m: PluginManifestInput) => void = () => {}): Promise<Record<string, Uint8Array>> {
  const manifest: PluginManifestInput = {
    format: 1,
    id: 'sky',
    name: 'Sky cards',
    version: '0.2.0',
    author: 'Rick',
    licence: 'Apache-2.0',
    summary: 'Draws sky cards.',
    minApp: '1.0.0',
    instructions: 'instructions.md',
    data: { cards: 'data/cards.json' },
    assets: [{ id: 'moon', url: 'https://cards.example.com/moon.jpg', type: 'image/jpeg', bytes: JPEG.length, sha256: (await pageSha256(JPEG)) ?? '', licence: 'Public domain', source: 'test' }],
    tools: [{ name: 'draw', description: 'Draws a card.', steps: [{ use: 'draw', as: 'card', table: 'cards' }, { use: 'show', board: 'wall', items: '$card' }], returns: ['card'] }],
    boards: { wall: { layout: 'cards', image: 'image', caption: '{{name}}' } },
    settings: { reversals: { type: 'switch', label: 'Cards can come up reversed', default: true } },
  };
  edit(manifest);
  return {
    [`${BASE}plugin.json`]: encode(JSON.stringify(manifest)),
    [`${BASE}instructions.md`]: encode('Draw when asked.'),
    [`${BASE}data/cards.json`]: encode(JSON.stringify([{ id: 'moon', name: 'The Moon', image: 'moon' }])),
  };
}

function deps(files: Record<string, Uint8Array>, store = new FakeMemoryStore()): PluginsDeps & { readonly store: FakeMemoryStore; readonly requests: string[] } {
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    const bytes = files[String(input)];
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes as Uint8Array<ArrayBuffer>);
  }) as typeof fetch;
  return { shelf: new InMemoryPluginShelf(), assets: new PluginAssets({ fetch: fetcher, cache: async () => null }), fetch: fetcher, memory: async () => store, appVersion: '1.0.0', store, requests };
}

function Harness({ given, onSettings }: { readonly given: PluginsDeps; readonly onSettings: (settings: Settings) => void }): ReactElement {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  return (
    <PluginsSection
      deps={given}
      onChange={(update) =>
        setSettings((prev) => {
          const next = update(prev);
          onSettings(next);
          return next;
        })
      }
      settings={settings}
    />
  );
}

async function readAddress(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Or its address'), { target: { value: `${BASE}plugin.json` } });
  fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
  await screen.findByRole('region', { name: 'Install Sky cards' });
}

describe('PluginsSection (P10-T03)', () => {
  it('reaches nothing until a source is given', async () => {
    const given = deps(await served());
    render(<Harness given={given} onSettings={() => {}} />);
    await screen.findByText('No plugins installed.');
    expect(given.requests).toEqual([]);
  });

  it('shows the consent screen, keeps nothing until Install, then lists it, on for the active character', async () => {
    const given = deps(await served());
    let latest = DEFAULT_SETTINGS;
    const { container } = render(<Harness given={given} onSettings={(next) => (latest = next)} />);
    await readAddress();
    const consent = screen.getByRole('region', { name: 'Install Sky cards' });
    expect(within(consent).getByText('Install Sky cards 0.2.0?')).toBeTruthy();
    expect(within(consent).getByText(/Rick · Apache-2.0/)).toBeTruthy();
    expect(within(consent).getByText('cards.example.com, plugins.example.com')).toBeTruthy();
    expect(within(consent).getByText('1 × Public domain')).toBeTruthy();
    expect(within(consent).getByText('sky__draw')).toBeTruthy();
    expect(within(consent).getByText(/Runs without asking/)).toBeTruthy();
    expect(within(consent).getByText(/About \d+ tokens in every request while it is on \(an estimate\)\. It can be set to load only when needed\./)).toBeTruthy();
    // The address asset is not downloaded to show the consent screen.
    expect(given.requests.some((url) => url.includes('moon.jpg'))).toBe(false);
    expect(await given.shelf.list()).toEqual([]);
    await expectAccessible(container);

    fireEvent.click(within(consent).getByRole('button', { name: 'Install' }));
    const list = await screen.findByRole('list', { name: 'Installed plugins' });
    expect(within(list).getByText('Sky cards 0.2.0')).toBeTruthy();
    expect(latest.characters['alice']?.plugins).toEqual(['sky']);
    expect((within(list).getByLabelText('On for Alice') as HTMLInputElement).checked).toBe(true);
    expect((within(list).getByLabelText('On for Theo') as HTMLInputElement).checked).toBe(false);
    await expectAccessible(container);
  });

  it('turns it on per character, and keeps its own settings', async () => {
    const given = deps(await served());
    let latest = DEFAULT_SETTINGS;
    render(<Harness given={given} onSettings={(next) => (latest = next)} />);
    await readAddress();
    fireEvent.click(screen.getByLabelText('Turn it on for Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    const list = await screen.findByRole('list', { name: 'Installed plugins' });
    expect(latest.characters['alice']?.plugins ?? []).toEqual([]);
    fireEvent.click(within(list).getByLabelText('On for Theo'));
    expect(latest.characters['theo']?.plugins).toEqual(['sky']);
    const reversals = within(list).getByLabelText('Cards can come up reversed') as HTMLInputElement;
    expect(reversals.checked).toBe(true);
    fireEvent.click(reversals);
    expect(latest.plugins).toEqual({ sky: { reversals: false } });
    expect(within(list).getByText(/About \d+ tokens in every request while it is on \(an estimate\); \d+ if it loads only when needed\./)).toBeTruthy();
    fireEvent.click(within(list).getByLabelText(/^Load only when needed/));
    expect(latest.lazyPlugins).toEqual(['sky']);
  });

  it('lists every problem with a plugin that cannot be installed', async () => {
    const files = await served((m) => (m.id = 'Sky Cards'));
    render(<Harness given={deps(files)} onSettings={() => {}} />);
    fireEvent.change(screen.getByLabelText('Or its address'), { target: { value: `${BASE}plugin.json` } });
    fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('It cannot be installed:')).toBeTruthy();
    expect(within(alert).getByText(/plugin\.json, id: must be 2 to 24 characters/)).toBeTruthy();
  });

  it('removes it with no trace, forgetting what it kept only when asked', async () => {
    const given = deps(await served());
    await given.store.writeBlock({ characterId: 'alice', name: '_plugin:sky', content: '{"history":["The Moon"]}', updatedAt: '2026-11-06T12:00:00Z', editableByCharacter: false });
    let latest = DEFAULT_SETTINGS;
    render(<Harness given={given} onSettings={(next) => (latest = next)} />);
    await readAddress();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    const list = await screen.findByRole('list', { name: 'Installed plugins' });
    fireEvent.click(within(list).getByLabelText('Cards can come up reversed'));

    fireEvent.click(within(list).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(list).getByLabelText('Also forget what it kept for each character'));
    fireEvent.click(within(list).getByRole('button', { name: 'Remove Sky cards' }));
    await screen.findByText('No plugins installed.');
    expect(await given.shelf.list()).toEqual([]);
    expect(latest.characters['alice']?.plugins).toEqual([]);
    expect(latest.plugins).toEqual({});
    await waitFor(async () => expect((await given.store.readBlocks('alice')).find((block) => block.name === '_plugin:sky')?.content).toBe(''));
  });
});
