import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PluginIndexSchema } from '@latentpresence/protocol';
import { diskFolder, sha256Hex } from './folder';
import { indexEntry, withEntries } from './listing';

/** The index entries `pnpm plugin:index` writes (P10-T09, ADR-72 item 9), from the first-party folders. */
const PLUGINS = fileURLToPath(new URL('../../../plugins', import.meta.url));
const sha = (path: string) => sha256Hex(readFileSync(join(PLUGINS, path)));

describe('indexEntry', () => {
  it('pins the manifest and every file it names, for Tarot and for Office', async () => {
    const tarot = await indexEntry(diskFolder(join(PLUGINS, 'tarot')), 'https://raw.githubusercontent.com/o/r/c0ffee/plugins/tarot/plugin.json', sha256Hex, ['divination']);
    expect(tarot).toMatchObject({ id: 'tarot', name: 'Tarot', version: '0.2.0', licence: 'Apache-2.0', tags: ['divination'], sha256: await sha('tarot/plugin.json') });
    expect(tarot.files).toEqual({ 'data/cards.json': await sha('tarot/data/cards.json'), 'data/spreads.json': await sha('tarot/data/spreads.json'), 'instructions.md': await sha('tarot/instructions.md') });
    const office = await indexEntry(diskFolder(join(PLUGINS, 'office')), 'https://raw.githubusercontent.com/o/r/c0ffee/plugins/office/plugin.json', sha256Hex);
    expect(Object.keys(office.files)).toEqual(['instructions.md']);

    const index = withEntries(withEntries(null, [tarot]), [office, { ...tarot, version: '0.3.0' }]);
    expect(PluginIndexSchema.parse(index).plugins.map((plugin) => `${plugin.id} ${plugin.version}`)).toEqual(['office 0.1.0', 'tarot 0.3.0']);
  });

  it('refuses to list a plugin that would not install', async () => {
    const broken = { ...diskFolder(join(PLUGINS, 'office')), text: async () => null };
    await expect(indexEntry(broken, 'https://x.example/plugin.json', sha256Hex)).rejects.toThrow('It is not a valid plugin');
  });
});
