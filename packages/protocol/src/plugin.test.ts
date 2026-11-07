import { describe, expect, it } from 'vitest';
import committedIndex from './generated/plugin-index.schema.json' with { type: 'json' };
import committed from './generated/plugin.schema.json' with { type: 'json' };
import { PluginIndexSchema, PluginManifestSchema, PluginStepSchema, pluginIndexJsonSchema, pluginManifestJsonSchema, type PluginManifestInput } from './plugin';

const MINIMAL: PluginManifestInput = {
  format: 1,
  id: 'coin',
  name: 'Coin',
  version: '0.1.0',
  author: 'Test',
  licence: 'Apache-2.0',
  summary: 'Flips a coin.',
  minApp: '1.0.0',
  instructions: 'instructions.md',
};

const FULL: PluginManifestInput = {
  ...MINIMAL,
  homepage: 'https://example.com/coin',
  data: { faces: 'data/faces.json' },
  assets: [{ id: 'heads', path: 'img/heads.png', type: 'image/png', bytes: 10, sha256: 'a'.repeat(64), licence: 'CC0-1.0', source: 'drawn for this test' }],
  tools: [
    {
      name: 'flip',
      description: 'Flips the coin.',
      parameters: { times: { type: 'integer', description: 'How many flips.', minimum: 1, maximum: 3 } },
      steps: [
        { use: 'draw', as: 'face', table: 'faces', count: '$args.times' },
        { use: 'show', board: 'coin', items: '$face' },
        { use: 'state', op: 'append', key: 'history', value: '$face' },
      ],
      returns: ['face'],
    },
  ],
  boards: { coin: { layout: 'cards', image: 'image', caption: '{{name}}' } },
  mcp: [{ id: 'notes', name: 'Notes', transport: 'http', url: 'https://example.com/mcp' }],
  schedules: [{ id: 'daily', description: 'A flip every morning', cron: '0 9 * * *', taskPrompt: 'Flip the coin and say how it landed.', tools: ['flip'], delivery: 'speak_next_session' }],
  settings: { greeting: { type: 'text', label: 'Greeting', default: 'Heads or tails?' } },
};

function problems(input: unknown): string[] {
  const result = PluginManifestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('PluginManifestSchema (P10-T01, ADR-72)', () => {
  it('round-trips a manifest through JSON, with the defaults written out', () => {
    for (const input of [MINIMAL, FULL]) {
      const parsed = PluginManifestSchema.parse(input);
      expect(PluginManifestSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
    const minimal = PluginManifestSchema.parse(MINIMAL);
    expect(minimal).toMatchObject({ data: {}, assets: [], tools: [], boards: {}, mcp: [], schedules: [], settings: {} });
    const full = PluginManifestSchema.parse(FULL);
    expect(full.tools[0]).toMatchObject({ policy: 'auto', steps: [{ reversed: 0 }, {}, {}] });
    expect(full.boards['coin']).toMatchObject({ where: 'screen' });
    expect(full.schedules[0]).toMatchObject({ catchUp: 'skip' });
  });

  it('refuses an unknown key, since in a hand-written file it is a typo', () => {
    expect(problems({ ...MINIMAL, tool: [] })).toEqual([': Unrecognized key: "tool"']);
  });

  it('refuses a newer format', () => {
    expect(problems({ ...MINIMAL, format: 2 })).toHaveLength(1);
  });

  it('says what an id, a path and an address must be', () => {
    expect(problems({ ...MINIMAL, id: 'Tarot Deck' })).toEqual(['id: must be 2 to 24 characters: lowercase letters, digits and hyphens, starting with a letter']);
    expect(problems({ ...MINIMAL, id: 'a'.repeat(25) })).toHaveLength(1);
    for (const path of ['../secret.md', '/etc/passwd', 'a/../b.md', '.hidden.md', 'C:\\x.md', 'a//b.md']) {
      expect(problems({ ...MINIMAL, instructions: path }), path).toEqual(['instructions: must be a path inside the plugin folder, with forward slashes and no ".."']);
    }
    expect(problems({ ...MINIMAL, instructions: 'docs/how-to.v2.md' })).toEqual([]);
    expect(problems({ ...MINIMAL, homepage: 'http://example.com' })).toEqual(['homepage: must be an https address']);
  });

  it('needs an asset in the folder or at an address, never both or neither', () => {
    const asset = FULL.assets?.[0];
    expect(problems({ ...MINIMAL, assets: [{ ...asset, url: 'https://example.com/heads.png' }] })).toEqual(['assets.0: an asset needs a "path" or a "url", not both']);
    expect(problems({ ...MINIMAL, assets: [{ ...asset, path: undefined }] })).toEqual(['assets.0: an asset needs a "path" or a "url", not both']);
    expect(problems({ ...MINIMAL, assets: [{ ...asset, sha256: 'A'.repeat(64) }] })).toEqual(['assets.0.sha256: must be 64 lowercase hex characters']);
  });

  it('names an unknown primitive', () => {
    const result = PluginStepSchema.safeParse({ use: 'shuffle', as: 'x', table: 'cards' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['use'], note: 'No matching discriminator' });
  });

  it('holds a state step to its operation', () => {
    expect(PluginStepSchema.safeParse({ use: 'state', op: 'set', key: 'last' }).success).toBe(false);
    expect(PluginStepSchema.safeParse({ use: 'state', op: 'clear', key: 'last', value: 1 }).success).toBe(false);
    expect(PluginStepSchema.safeParse({ use: 'state', op: 'get', key: 'last' }).success).toBe(false);
    expect(PluginStepSchema.safeParse({ use: 'state', op: 'get', key: 'last', as: 'last' }).success).toBe(true);
  });

  it('reads dice notation and references', () => {
    for (const dice of ['d20', '3d6', '2d10+1', '$args.dice']) expect(PluginStepSchema.safeParse({ use: 'roll', as: 'r', dice }).success, dice).toBe(true);
    for (const dice of ['20', 'd', '3d6*2', '$Args']) expect(PluginStepSchema.safeParse({ use: 'roll', as: 'r', dice }).success, dice).toBe(false);
  });

  it('is the JSON Schema that is committed — run `pnpm plugin:schema` after changing plugin.ts', () => {
    expect(pluginManifestJsonSchema()).toEqual(committed);
    expect(pluginIndexJsonSchema()).toEqual(committedIndex);
  });
});

describe('PluginIndexSchema (ADR-72 item 9)', () => {
  const entry = { id: 'tarot', name: 'Tarot', summary: 'Draws cards.', author: 'Rick', version: '0.2.0', licence: 'Apache-2.0', manifest: 'https://raw.githubusercontent.com/o/r/0123/plugins/tarot/plugin.json', sha256: 'a'.repeat(64), files: { 'instructions.md': 'b'.repeat(64) } };
  it('reads an index and refuses an entry that is not pinned or not https', () => {
    expect(PluginIndexSchema.parse({ format: 1, plugins: [entry] }).plugins[0]?.tags).toEqual([]);
    expect(PluginIndexSchema.safeParse({ format: 1, plugins: [{ ...entry, sha256: 'abc' }] }).success).toBe(false);
    expect(PluginIndexSchema.safeParse({ format: 1, plugins: [{ ...entry, manifest: 'http://x.example/plugin.json' }] }).success).toBe(false);
    expect(PluginIndexSchema.safeParse({ format: 1, plugins: [{ ...entry, files: { '../x': 'b'.repeat(64) } }] }).success).toBe(false);
    expect(PluginIndexSchema.safeParse({ format: 2, plugins: [] }).success).toBe(false);
  });
});
