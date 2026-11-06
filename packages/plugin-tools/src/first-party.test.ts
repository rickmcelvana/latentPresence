import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFolder } from './run';

/**
 * Every plugin in `plugins/` passes `checkPlugin` from disk (ADR-72 item 10), as installing it would
 * check it — without the downloads, which `pnpm plugin:check <folder> --fetch` does. A plugin the app
 * ships cannot go red quietly.
 */
const PLUGINS = fileURLToPath(new URL('../../../plugins/', import.meta.url));
const APP_VERSION = (JSON.parse(readFileSync(new URL('../../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { version: string }).version;
const folders = readdirSync(PLUGINS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe('the first-party plugins (P10-T01)', () => {
  it('include the tarot draft', () => {
    expect(folders).toContain('tarot');
  });

  for (const name of folders) {
    it(`${name} passes plugin:check against this app's version`, async () => {
      const result = await checkFolder(`${PLUGINS}${name}`, { appVersion: APP_VERSION });
      expect(result.ok ? [] : result.problems).toEqual([]);
      expect(result.ok && result.plugin.manifest.id).toBe(name);
    });
  }

  it('tarot: Rick\'s 78 cards in his numbering, each with its pinned JPEG (SURFACE.md, 2026-11-06)', async () => {
    const result = await checkFolder(`${PLUGINS}tarot`);
    if (!result.ok) throw new Error(result.problems.join('\n'));
    const { manifest, data, assetBytes } = result.plugin;
    const cards = data['cards'] ?? [];
    expect(cards).toHaveLength(78);
    // The map in his Open WebUI tool (Z:\dev\tarot\tarot.py, v0.7.0): Waite's order, then the suits.
    const named = (number: number) => cards.find((card) => card['number'] === number)?.['name'];
    expect([1, 9, 12, 22, 23, 36, 37, 51, 65, 78].map(named)).toEqual([
      'The Fool', 'Strength', 'Justice', 'The World', 'Ace of Wands', 'King of Wands', 'Ace of Cups', 'Ace of Swords', 'Ace of Pentacles', 'King of Pentacles',
    ]);
    expect(manifest.assets).toHaveLength(78);
    for (const card of cards) {
      const asset = manifest.assets.find((entry) => entry.id === card['image']);
      expect(asset?.url, String(card['name'])).toBe(`https://moongoddesscoven.com/tarot/${String(card['number'])}.jpg`);
      expect(asset?.type).toBe('image/jpeg');
    }
    expect(assetBytes).toBe(4_837_006);
    expect(new Set(manifest.assets.map((asset) => asset.sha256)).size).toBe(78);
  });
});
