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
import { FakeCompanionConfig } from '../desktop/companion-config.fake';

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

/** A plugin offering an HTTP server, a program and a daily schedule (P10-T07). */
function offering(m: PluginManifestInput): void {
  m.mcp = [
    { id: 'wiki', name: 'Wiki', transport: 'http', url: 'https://mcp.example.com/mcp' },
    { id: 'docs', name: 'Documents', transport: 'stdio', command: 'npx', args: ['-y', '@example/docs-mcp'] },
  ];
  m.schedules = [{ id: 'daily', description: 'A daily sky card', cron: '0 9 * * *', taskPrompt: 'Draw a card and tell them.', tools: ['draw', 'wiki__search'], delivery: 'notify' }];
}

function deps(files: Record<string, Uint8Array>, store = new FakeMemoryStore(), companion: FakeCompanionConfig | null = null): PluginsDeps & { readonly store: FakeMemoryStore; readonly requests: string[] } {
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    const bytes = files[String(input)];
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes as Uint8Array<ArrayBuffer>);
  }) as typeof fetch;
  return { shelf: new InMemoryPluginShelf(), assets: new PluginAssets({ fetch: fetcher, cache: async () => null }), fetch: fetcher, memory: async () => store, appVersion: '1.0.0', companion, timeZone: 'America/Toronto', indexUrl: 'https://latentpresence.com/plugins/index.json', store, requests };
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

  describe('what it offers beyond its tools (P10-T07, ADR-72 item 7)', () => {

    it('asks once for each, adds each where it belongs, tagged, and removing the plugin leaves everything as it was', async () => {
      const companion = new FakeCompanionConfig();
      const store = new FakeMemoryStore();
      const given = deps(await served(offering), store, companion);
      let latest = DEFAULT_SETTINGS;
      render(<Harness given={given} onSettings={(next) => (latest = next)} />);
      await readAddress();
      const consent = screen.getByRole('region', { name: 'Install Sky cards' });
      expect(within(consent).getByText('Server: Wiki')).toBeTruthy();
      expect(within(consent).getByText('npx -y @example/docs-mcp')).toBeTruthy();
      fireEvent.click(within(consent).getByRole('button', { name: 'Install' }));
      const offers = await screen.findByRole('list', { name: 'What Sky cards offers' });
      expect(within(offers).getAllByRole('listitem')).toHaveLength(3);
      // Installing added nothing: each waits for its own answer.
      expect(latest.tools.servers).toEqual([]);
      expect(companion.pluginAsks).toEqual([]);
      expect(await store.listSchedules('alice')).toEqual([]);

      // The HTTP server joins Settings → Tools, tagged.
      fireEvent.click(within(offers).getAllByRole('button', { name: 'Add it' })[0]!);
      await waitFor(() => expect(latest.tools.servers).toEqual([{ id: 'plugin:sky:wiki', label: 'Wiki', url: 'https://mcp.example.com/mcp', transport: 'http', enabled: true, auth: 'none', plugin: 'sky' }]));
      // The program goes to the shell, which asks in its own dialog with the whole command.
      fireEvent.click(within(offers).getByRole('button', { name: 'Add it…' }));
      await waitFor(() => expect(companion.config.servers).toEqual([{ name: 'sky-docs', summary: 'npx -y @example/docs-mcp', disabled: false, plugin: 'sky' }]));
      expect(companion.pluginAsks).toEqual([{ plugin: 'sky', pluginName: 'Sky cards', server: 'docs', serverName: 'Documents', command: 'npx', args: ['-y', '@example/docs-mcp'] }]);
      expect(latest.tools.companion).toBe(true);
      // The schedule is made for Alice, daily at 9 in her zone, with her tools by their names.
      fireEvent.click(within(offers).getByRole('button', { name: 'Make it' }));
      await waitFor(async () => expect(await store.listSchedules('alice')).toHaveLength(1));
      const [made] = await store.listSchedules('alice');
      expect(made).toMatchObject({ description: 'A daily sky card', trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/Toronto' }, taskPrompt: 'Draw a card and tell them.', allowedTools: ['sky__draw', 'wiki__search'], status: 'active' });
      // Each was asked once: nothing is left to answer.
      await waitFor(() => expect(within(offers).queryAllByRole('button')).toEqual([]));
      expect(latest.pluginOffers['sky']).toEqual({ 'server:wiki': 'added', 'server:docs': 'added', 'schedule:alice:daily': made?.id });

      fireEvent.click(within(screen.getByRole('list', { name: 'Installed plugins' })).getByRole('button', { name: 'Remove' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove Sky cards' }));
      await screen.findByText('No plugins installed.');
      expect(latest.tools).toEqual({ ...DEFAULT_SETTINGS.tools, companion: true });
      expect(latest.pluginOffers).toEqual({});
      expect(companion.config.servers).toEqual([]);
      expect(await store.listSchedules('alice')).toEqual([]);
    });

    it('says why it could not be removed when a schedule it made cannot be deleted, and keeps it (R-70)', async () => {
      const store = new FakeMemoryStore();
      const given = deps(await served(offering), store);
      render(<Harness given={given} onSettings={() => {}} />);
      await readAddress();
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
      const offers = await screen.findByRole('list', { name: 'What Sky cards offers' });
      fireEvent.click(within(offers).getByRole('button', { name: 'Make it' }));
      await waitFor(async () => expect(await store.listSchedules('alice')).toHaveLength(1));
      // The companion refused the request, as a preflight without DELETE did.
      store.deleteSchedule = () => Promise.reject(new TypeError('Failed to fetch'));

      fireEvent.click(within(screen.getByRole('list', { name: 'Installed plugins' })).getByRole('button', { name: 'Remove' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove Sky cards' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/^A schedule it made could not be deleted \(Failed to fetch\), so nothing was removed\./u);
      expect(await given.shelf.list()).toHaveLength(1);
      expect(await store.listSchedules('alice')).toHaveLength(1);
    });

    it('says a program needs the desktop app, and takes a no thanks as the answer', async () => {
      const given = deps(await served(offering));
      let latest = DEFAULT_SETTINGS;
      render(<Harness given={given} onSettings={(next) => (latest = next)} />);
      await readAddress();
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
      const offers = await screen.findByRole('list', { name: 'What Sky cards offers' });
      expect(within(offers).getByText('Only in the desktop app, where the companion may start programs.')).toBeTruthy();
      expect(within(offers).queryByRole('button', { name: 'Add it…' })).toBeNull();
      fireEvent.click(within(offers).getAllByRole('button', { name: 'No thanks' })[0]!);
      expect(latest.pluginOffers['sky']).toEqual({ 'server:wiki': 'declined' });
      expect(within(offers).getByText('Not added.')).toBeTruthy();
      expect(latest.tools.servers).toEqual([]);
    });
  });
});

describe('Browse (P10-T09, ADR-72 item 9)', () => {
  const INDEX = 'https://latentpresence.com/plugins/index.json';

  /** The index entry for the served sky plugin, with every file's hash as served. */
  async function listed(files: Record<string, Uint8Array>, extra: Record<string, unknown> = {}): Promise<Record<string, Uint8Array>> {
    const hash = async (path: string) => (await pageSha256(files[`${BASE}${path}`]!)) ?? '';
    const entry = {
      id: 'sky',
      name: 'Sky cards',
      summary: 'Draws sky cards.',
      author: 'Rick',
      version: '0.2.0',
      licence: 'Apache-2.0',
      tags: ['cards'],
      manifest: `${BASE}plugin.json`,
      sha256: await hash('plugin.json'),
      files: { 'instructions.md': await hash('instructions.md'), 'data/cards.json': await hash('data/cards.json') },
      ...extra,
    };
    return { ...files, [INDEX]: encode(JSON.stringify({ format: 1, plugins: [entry, { id: 'Broken entry' }] })) };
  }

  it('fetches the index only on the press, lists it, and installs a listed plugin with every file checked', async () => {
    const given = deps(await listed(await served()));
    const { container } = render(<Harness given={given} onSettings={() => {}} />);
    await screen.findByText('No plugins installed.');
    expect(given.requests).toEqual([]);
    expect(screen.getByText('Fetches the list from latentpresence.com, only when you press it.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Browse plugins…' }));
    const list = await screen.findByRole('list', { name: 'Plugins in the index' });
    expect(given.requests).toEqual([INDEX]);
    expect(within(list).getByText('Sky cards 0.2.0')).toBeTruthy();
    expect(within(list).getByText('Rick · Apache-2.0 · cards')).toBeTruthy();
    expect(screen.getByText('1 more could not be read by this version of the app.')).toBeTruthy();
    await expectAccessible(container);

    fireEvent.click(within(list).getByRole('button', { name: 'Read it' }));
    const consent = await screen.findByRole('region', { name: 'Install Sky cards' });
    expect(within(consent).getByText(/listed in the latentPresence index and unchanged since/)).toBeTruthy();
    expect(within(consent).queryByText(/Not in the latentPresence index/)).toBeNull();
    fireEvent.click(within(consent).getByRole('button', { name: 'Install' }));
    await screen.findByRole('list', { name: 'Installed plugins' });
    expect(within(screen.getByRole('list', { name: 'Plugins in the index' })).getByText('Installed')).toBeTruthy();
  });

  it('refuses a listed plugin whose manifest or a file changed since it was listed', async () => {
    const files = await served();
    const index = await listed(files);
    // The data changed after listing.
    const given = deps({ ...index, [`${BASE}data/cards.json`]: encode('[{"id":"sun","name":"The Sun","image":"moon"}]') });
    render(<Harness given={given} onSettings={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse plugins…' }));
    fireEvent.click(within(await screen.findByRole('list', { name: 'Plugins in the index' })).getByRole('button', { name: 'Read it' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Sky cards's data/cards.json is not the one that was listed");
    expect(await given.shelf.list()).toEqual([]);
    cleanup();

    // The manifest changed: a new version served at the same address.
    const bumped = await served((m) => (m.version = '0.3.0'));
    const changed = deps({ ...index, [`${BASE}plugin.json`]: bumped[`${BASE}plugin.json`]! });
    render(<Harness given={changed} onSettings={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse plugins…' }));
    fireEvent.click(within(await screen.findByRole('list', { name: 'Plugins in the index' })).getByRole('button', { name: 'Read it' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Sky cards's plugin.json is not the one that was listed");
    expect(changed.requests.some((url) => url.endsWith('instructions.md'))).toBe(false);
  });

  it('says so when the index cannot be reached, and marks a plugin from an address as not in the index', async () => {
    const given = deps(await served());
    render(<Harness given={given} onSettings={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse plugins…' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The list could not be fetched. The index at latentpresence.com answered 404.');
    await readAddress();
    expect(screen.getByText(/Not in the latentPresence index: nobody there has looked at it/)).toBeTruthy();
  });
});
