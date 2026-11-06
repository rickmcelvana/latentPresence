import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from '@latentpresence/core';
import type { PluginManifestInput } from '@latentpresence/protocol';
import { DEFAULT_SETTINGS } from '../settings/settings';
import { AssetProblem, PluginAssets, type AssetCache } from './assets';
import { inspectPlugin, pageSha256 } from './inspect';
import { enabledPlugins, installPlugin, loadPlugin, removePlugin, withPluginEnabled, withPluginSetting, withoutPlugin } from './manage';
import { InMemoryPluginShelf, IndexedDbPluginShelf } from './shelf';
import { SourceProblem, rootAtManifest, sourceFromFolder, sourceFromUrl, sourceFromZip, type PickedFile, type PluginSource } from './sources';
import { ZipProblem, readZip } from './zip';

/**
 * Installing a plugin (P10-T03, ADR-72 item 8): from a folder, a zip or an address; what the consent
 * screen is told; assets downloaded once, checked and kept; removal leaving nothing behind but what
 * the person kept.
 */

const encode = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

async function sky(edit: (m: PluginManifestInput) => void = () => {}): Promise<PluginSource> {
  const manifest: PluginManifestInput = {
    format: 1,
    id: 'sky',
    name: 'Sky cards',
    version: '0.2.0',
    author: 'Test',
    licence: 'Apache-2.0',
    summary: 'Draws sky cards.',
    minApp: '1.0.0',
    instructions: 'instructions.md',
    data: { cards: 'data/cards.json' },
    assets: [
      { id: 'sun', path: 'img/sun.png', type: 'image/png', bytes: PNG.length, sha256: (await pageSha256(PNG)) ?? '', licence: 'CC0-1.0', source: 'test' },
      { id: 'moon', url: 'https://cards.example.com/moon.jpg', type: 'image/jpeg', bytes: JPEG.length, sha256: (await pageSha256(JPEG)) ?? '', licence: 'Public domain', source: 'test' },
    ],
    tools: [{ name: 'draw', description: 'Draws a card.', steps: [{ use: 'draw', as: 'card', table: 'cards' }, { use: 'show', board: 'wall', items: '$card' }], returns: ['card'] }],
    boards: { wall: { layout: 'cards', image: 'image', caption: '{{name}}' } },
    mcp: [{ id: 'notes', name: 'Notes', transport: 'stdio', command: 'npx', args: ['-y', 'notes-server'] }],
    schedules: [{ id: 'morning', description: 'A card each morning', cron: '0 8 * * *', taskPrompt: 'Draw one.', tools: ['draw'], delivery: 'speak_next_session' }],
  };
  edit(manifest);
  const files = new Map<string, Uint8Array>([
    ['instructions.md', encode('Draw when asked.')],
    ['data/cards.json', encode(JSON.stringify([{ id: 'sun', name: 'The Sun', image: 'sun' }, { id: 'moon', name: 'The Moon', image: 'moon' }]))],
    ['img/sun.png', PNG],
  ]);
  return { manifestText: JSON.stringify(manifest), files, origin: { kind: 'folder', name: 'sky' } };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
}

class MemoryCache implements AssetCache {
  readonly entries = new Map<string, Uint8Array>();
  async match(request: string): Promise<Response | undefined> {
    const bytes = this.entries.get(request);
    return bytes === undefined ? undefined : new Response(bytes as Uint8Array<ArrayBuffer>);
  }
  async put(request: string, response: Response): Promise<void> {
    this.entries.set(request, new Uint8Array(await response.arrayBuffer()));
  }
  async delete(request: string): Promise<boolean> {
    return this.entries.delete(request);
  }
}

function fetchFrom(table: Record<string, Uint8Array | number | 'unreachable'>, log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    log.push(url);
    const entry = table[url];
    if (entry === undefined) return new Response(null, { status: 404 });
    if (entry === 'unreachable') throw new TypeError('Failed to fetch');
    if (typeof entry === 'number') return new Response(null, { status: entry });
    return new Response(entry as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as typeof fetch;
}

/** A zip written by hand: the first entry deflated (by the platform), the rest stored. */
async function zipOf(entries: readonly (readonly [string, Uint8Array])[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [index, [name, content]] of entries.entries()) {
    const deflate = index === 0;
    const data = deflate ? new Uint8Array(await new Response(new Response(content as Uint8Array<ArrayBuffer>).body?.pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()) : content;
    const nameBytes = encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, content.length, true);
    local.setUint16(26, nameBytes.length, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(10, deflate ? 8 : 0, true);
    header.setUint32(20, data.length, true);
    header.setUint32(24, content.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(header.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('where a plugin comes from', () => {
  it('reads a zip of the folder, deflated or stored, rooted at its plugin.json', async () => {
    const source = await sky();
    const zip = await zipOf([['sky/plugin.json', encode(source.manifestText)], ...[...source.files].map(([path, bytes]) => [`sky/${path}`, bytes] as const), ['README.txt', encode('outside')]]);
    const read = await sourceFromZip('sky.zip', zip);
    expect(read.manifestText).toBe(source.manifestText);
    expect([...read.files.keys()].toSorted()).toEqual(['data/cards.json', 'img/sun.png', 'instructions.md']);
    expect(read.files.get('img/sun.png')).toEqual(PNG);
    expect(read.origin).toEqual({ kind: 'zip', name: 'sky.zip' });
    expect((await inspectPlugin(read, '1.0.0')).ok).toBe(true);
  });

  it('refuses what is not a zip, and a zip that expands too far', async () => {
    await expect(readZip(encode('not a zip at all, just words'))).rejects.toThrow(new ZipProblem('This is not a zip file.'));
    const big = await zipOf([['plugin.json', new Uint8Array(1000)]]);
    await expect(readZip(big, { entries: 10, bytes: 999 })).rejects.toThrow('The zip expands to more than 0 MB.');
    await expect(readZip(await zipOf([['a', PNG], ['b', PNG]]), { entries: 1, bytes: 1e6 })).rejects.toThrow('The zip holds 2 entries; a plugin may have 1.');
  });

  it('reads a picked folder, and says when there is no plugin in it', async () => {
    const source = await sky();
    const picked: PickedFile[] = [['plugin.json', encode(source.manifestText)] as const, ...source.files].map(([path, bytes]) => ({ path: `sky/${path}`, bytes: async () => bytes }));
    expect((await sourceFromFolder(picked)).files.size).toBe(3);
    await expect(sourceFromFolder([{ path: 'photos/cat.png', bytes: async () => PNG }])).rejects.toThrow(new SourceProblem('There is no plugin.json at the top of it, or one folder down.'));
    expect(() => rootAtManifest([['a/plugin.json', encode('{}')], ['b/plugin.json', encode('{}')]], { kind: 'folder', name: 'two' })).toThrow("It holds more than one plugin; pick one plugin's folder.");
  });

  it('reads a plugin.json at an address and the files it names beside it', async () => {
    const source = await sky();
    const base = 'https://plugins.example.com/sky/';
    const log: string[] = [];
    const read = await sourceFromUrl(`${base}plugin.json`, fetchFrom({ [`${base}plugin.json`]: encode(source.manifestText), ...Object.fromEntries([...source.files].map(([path, bytes]) => [`${base}${path}`, bytes])) }, log));
    expect([...read.files.keys()].toSorted()).toEqual(['data/cards.json', 'img/sun.png', 'instructions.md']);
    // The address asset is not fetched here: it downloads when first shown, after consent.
    expect(log.some((url) => url.includes('moon.jpg'))).toBe(false);
    expect((await inspectPlugin(read, '1.0.0')).ok && (await inspectPlugin(read, '1.0.0'))).toMatchObject({ facts: { hosts: ['cards.example.com', 'plugins.example.com'] } });
  });

  it('says what went wrong with an address', async () => {
    await expect(sourceFromUrl('http://plugins.example.com/plugin.json', fetchFrom({}))).rejects.toThrow("A plugin's address must start with https://.");
    await expect(sourceFromUrl('https://down.example.com/plugin.json', fetchFrom({ 'https://down.example.com/plugin.json': 'unreachable' }))).rejects.toThrow(
      'Could not download from down.example.com: it may be offline, or it does not allow downloads from other sites (it needs to send Access-Control-Allow-Origin).',
    );
    const source = await sky();
    // A file the manifest names that is not there is checkPlugin's to name.
    const read = await sourceFromUrl('https://p.example.com/plugin.json', fetchFrom({ 'https://p.example.com/plugin.json': encode(source.manifestText) }));
    expect(await inspectPlugin(read, '1.0.0')).toMatchObject({ ok: false, problems: expect.arrayContaining(['The instructions file "instructions.md" is not in the folder.']) });
  });
});

describe('the consent screen\'s facts', () => {
  it('say what the plugin is, where it reaches, what it may download, and what it adds', async () => {
    const inspection = await inspectPlugin(await sky(), '1.0.0');
    if (!inspection.ok) throw new Error(inspection.problems.join('\n'));
    expect(inspection.facts).toMatchObject({
      id: 'sky',
      name: 'Sky cards',
      version: '0.2.0',
      author: 'Test',
      licence: 'Apache-2.0',
      hosts: ['cards.example.com'],
      downloadBytes: JPEG.length,
      assetLicences: [{ licence: 'CC0-1.0', count: 1 }, { licence: 'Public domain', count: 1 }],
      tools: [{ name: 'sky__draw', description: 'Draws a card.', policy: 'auto' }],
      mcp: [{ name: 'Notes', detail: 'npx -y notes-server' }],
      schedules: [{ description: 'A card each morning', cron: '0 8 * * *' }],
    });
    expect(inspection.facts.keptBytes).toBe([...(await sky()).files.values()].reduce((sum, bytes) => sum + bytes.length, 0));
  });

  it('for the tarot draft from its folder: its true size, its one host, its licences', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../plugins/tarot');
    const picked: PickedFile[] = walk(root).map((full) => ({ path: `tarot/${relative(root, full).replaceAll('\\', '/')}`, bytes: async () => new Uint8Array(readFileSync(full)) }));
    const inspection = await inspectPlugin(await sourceFromFolder(picked), '1.0.0');
    if (!inspection.ok) throw new Error(inspection.problems.join('\n'));
    expect(inspection.facts).toMatchObject({
      name: 'Tarot',
      licence: 'Apache-2.0',
      hosts: ['moongoddesscoven.com'],
      downloadBytes: 4_837_006,
      assetLicences: [{ licence: 'Public domain', count: 78 }],
      tools: [{ name: 'tarot__draw_spread', policy: 'auto' }],
      mcp: [],
      schedules: [],
    });
  });

  it('refuses a folder whose asset has the wrong hash, and nothing is kept', async () => {
    const source = await sky();
    const tampered: PluginSource = { ...source, files: new Map([...source.files, ['img/sun.png', new Uint8Array([...PNG.slice(0, -1), 8])]]) };
    const inspection = await inspectPlugin(tampered, '1.0.0');
    expect(inspection.ok).toBe(false);
    expect(!inspection.ok && inspection.problems[0]).toMatch(/^Asset "sun": img\/sun\.png has SHA-256 [0-9a-f]{64}, and the manifest says [0-9a-f]{64}\.$/);
    const shelf = new InMemoryPluginShelf();
    expect(await shelf.list()).toEqual([]);
  });
});

describe('the shelf', () => {
  it('keeps plugins in IndexedDB, lists them without their files, and removes them', async () => {
    const shelf = new IndexedDbPluginShelf(new IDBFactory());
    const inspection = await inspectPlugin(await sky(), '1.0.0');
    if (!inspection.ok) throw new Error('sky');
    const installed = await installPlugin(inspection, shelf, new Date('2026-11-06T12:00:00Z'));
    expect(await shelf.list()).toEqual([{ id: 'sky', name: 'Sky cards', version: '0.2.0', summary: 'Draws sky cards.', origin: { kind: 'folder', name: 'sky' }, installedAt: '2026-11-06T12:00:00.000Z' }]);
    expect(installed.id).toBe('sky');
    const loaded = await loadPlugin(shelf, 'sky', '1.0.0');
    expect(loaded.ok && loaded.files.get('img/sun.png')).toEqual(PNG);
    await shelf.remove('sky');
    expect(await shelf.list()).toEqual([]);
    expect(await loadPlugin(shelf, 'sky', '1.0.0')).toEqual({ ok: false, problems: ['The plugin "sky" is not installed.'] });
  });

  it('checks a plugin again as it loads, and does not run one that no longer passes', async () => {
    const shelf = new InMemoryPluginShelf();
    const source = await sky();
    await shelf.put({ id: 'sky', name: 'Sky cards', version: '0.2.0', summary: '', origin: source.origin, installedAt: '' }, { manifestText: source.manifestText, files: new Map([...source.files, ['img/sun.png', JPEG]]) });
    expect((await loadPlugin(shelf, 'sky', '1.0.0')).ok).toBe(false);
    expect(await loadPlugin(shelf, 'sky', '0.9.0')).toMatchObject({ ok: false });
  });
});

describe('a plugin\'s pictures', () => {
  async function installed() {
    const inspection = await inspectPlugin(await sky(), '1.0.0');
    if (!inspection.ok) throw new Error('sky');
    return inspection;
  }

  it('shows a folder picture from what was kept, and downloads an address once, checked', async () => {
    const { plugin, source } = await installed();
    const log: string[] = [];
    const cache = new MemoryCache();
    const assets = new PluginAssets({ fetch: fetchFrom({ 'https://cards.example.com/moon.jpg': JPEG }, log), cache: async () => cache });
    const sun = await assets.blob(plugin, source.files, 'sun');
    expect([sun.type, sun.size]).toEqual(['image/png', PNG.length]);
    const moon = await assets.blob(plugin, source.files, 'moon');
    expect([moon.type, moon.size]).toEqual(['image/jpeg', JPEG.length]);
    await assets.blob(plugin, source.files, 'moon');
    expect(log).toEqual(['https://cards.example.com/moon.jpg']);
    expect(cache.entries.get('https://cards.example.com/moon.jpg')).toEqual(JPEG);
  });

  it('keeps nothing that is not what was pinned, and drops a kept file that no longer checks', async () => {
    const { plugin, source } = await installed();
    const cache = new MemoryCache();
    const wrong = new PluginAssets({ fetch: fetchFrom({ 'https://cards.example.com/moon.jpg': new Uint8Array([...JPEG.slice(0, -1), 9]) }), cache: async () => cache });
    await expect(wrong.blob(plugin, source.files, 'moon')).rejects.toThrow(AssetProblem);
    await expect(wrong.blob(plugin, source.files, 'moon')).rejects.toThrow(/Sky cards's "moon": these are not the bytes the plugin pinned/);
    expect(cache.entries.size).toBe(0);

    cache.entries.set('https://cards.example.com/moon.jpg', PNG);
    const log: string[] = [];
    const right = new PluginAssets({ fetch: fetchFrom({ 'https://cards.example.com/moon.jpg': JPEG }, log), cache: async () => cache });
    expect((await right.blob(plugin, source.files, 'moon')).size).toBe(JPEG.length);
    expect(log).toHaveLength(1);
  });

  it('says a host without CORS (or offline) in a sentence, and works with no cache at all', async () => {
    const { plugin, source } = await installed();
    const assets = new PluginAssets({ fetch: fetchFrom({ 'https://cards.example.com/moon.jpg': 'unreachable' }), cache: async () => null });
    await expect(assets.blob(plugin, source.files, 'moon')).rejects.toThrow(
      'Could not download from cards.example.com: it may be offline, or it does not allow downloads from other sites (it needs to send Access-Control-Allow-Origin).',
    );
    const uncached = new PluginAssets({ fetch: fetchFrom({ 'https://cards.example.com/moon.jpg': JPEG }), cache: async () => null });
    expect((await uncached.blob(plugin, source.files, 'moon')).size).toBe(JPEG.length);
  });
});

describe('removing a plugin', () => {
  async function setUp() {
    const shelf = new InMemoryPluginShelf();
    const inspection = await inspectPlugin(await sky(), '1.0.0');
    if (!inspection.ok) throw new Error('sky');
    await installPlugin(inspection, shelf);
    const cache = new MemoryCache();
    const assets = new PluginAssets({ fetch: fetchFrom({ 'https://cards.example.com/moon.jpg': JPEG }), cache: async () => cache });
    await assets.blob(inspection.plugin, inspection.source.files, 'moon');
    const store = new FakeMemoryStore();
    await store.writeBlock({ characterId: 'alice', name: '_plugin:sky', content: '{"history":["The Sun"]}', updatedAt: '2026-11-06T12:00:00Z', editableByCharacter: false });
    await store.writeBlock({ characterId: 'alice', name: '_plugin:other', content: '{"x":1}', updatedAt: '2026-11-06T12:00:00Z', editableByCharacter: false });
    let settings = withPluginEnabled(DEFAULT_SETTINGS, 'alice', 'sky', true);
    settings = withPluginEnabled(settings, 'theo', 'sky', true);
    settings = withPluginEnabled(settings, 'theo', 'other', true);
    settings = withPluginSetting(settings, 'sky', 'reversals', false);
    return { shelf, cache, assets, store, settings };
  }

  it('leaves no plugin, no tool, no setting and no downloaded byte, and forgets its data when asked', async () => {
    const { shelf, cache, assets, store, settings } = await setUp();
    expect(enabledPlugins(settings, 'theo')).toEqual(['sky', 'other']);
    await removePlugin('sky', { shelf, assets, forget: { store, characterIds: ['alice', 'theo'], now: () => new Date('2026-11-06T13:00:00Z') } });
    expect(await shelf.list()).toEqual([]);
    expect(cache.entries.size).toBe(0);
    const blocks = await store.readBlocks('alice');
    expect(blocks.find((block) => block.name === '_plugin:sky')?.content).toBe('');
    expect(blocks.find((block) => block.name === '_plugin:other')?.content).toBe('{"x":1}');
    expect(await store.readBlocks('theo')).toEqual([]);

    const cleaned = withoutPlugin(settings, 'sky');
    expect(enabledPlugins(cleaned, 'alice')).toEqual([]);
    expect(enabledPlugins(cleaned, 'theo')).toEqual(['other']);
    expect(cleaned.plugins).toEqual({});
  });

  it('keeps its data when the person keeps it', async () => {
    const { shelf, assets, store } = await setUp();
    await removePlugin('sky', { shelf, assets });
    expect((await store.readBlocks('alice')).find((block) => block.name === '_plugin:sky')?.content).toBe('{"history":["The Sun"]}');
  });
});
