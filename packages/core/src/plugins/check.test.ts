import { describe, expect, it } from 'vitest';
import type { PluginManifestInput } from '@latentpresence/protocol';
import { checkPlugin, compareVersions, type CheckPluginOptions, type PluginFolder } from './check';

/**
 * `checkPlugin` (P10-T01, ADR-72): the done-when's broken manifests each refused with a sentence
 * naming the problem, and the cross-references the schema cannot see. The real tarot folder is
 * checked from disk in `packages/plugin-tools` (the core has no file system).
 */

/** Not SHA-256: a stand-in the check can only compare, which is all it does with a hash. */
async function fakeSha(bytes: Uint8Array): Promise<string> {
  let h = 0;
  for (const byte of bytes) h = (h * 31 + byte) >>> 0;
  return h.toString(16).padStart(64, '0');
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6]);

const CARDS = [
  { id: 'sun', name: 'The Sun', image: 'sun' },
  { id: 'moon', name: 'The Moon', image: 'moon' },
  { id: 'star', name: 'The Star', image: 'star' },
];
const SPREADS = [{ id: 'two', name: 'Two cards', positions: ['Now', 'Next'] }];

function manifest(): PluginManifestInput & { tools: NonNullable<PluginManifestInput['tools']> } {
  return {
    format: 1,
    id: 'sky',
    name: 'Sky cards',
    version: '0.1.0',
    author: 'Test',
    licence: 'Apache-2.0',
    summary: 'Draws sky cards.',
    minApp: '1.0.0',
    instructions: 'instructions.md',
    data: { cards: 'data/cards.json', spreads: 'data/spreads.json' },
    assets: [
      { id: 'sun', path: 'img/sun.png', type: 'image/png', bytes: PNG.length, sha256: '', licence: 'CC0-1.0', source: 'test' },
      { id: 'moon', path: 'img/moon.png', type: 'image/png', bytes: PNG.length, sha256: '', licence: 'CC0-1.0', source: 'test' },
      { id: 'star', url: 'https://example.com/star.jpg', type: 'image/jpeg', bytes: JPEG.length, sha256: '', licence: 'CC0-1.0', source: 'test' },
    ],
    tools: [
      {
        name: 'draw',
        description: 'Draws a spread.',
        parameters: { spread: { type: 'string', description: 'Which spread.', enumFrom: { table: 'spreads', column: 'id' }, required: true } },
        steps: [
          { use: 'lookup', as: 'spread', table: 'spreads', key: '$args.spread' },
          { use: 'draw', as: 'cards', table: 'cards', slots: '$spread.positions', reversed: '$settings.reversals' },
          { use: 'show', board: 'wall', items: '$cards', title: '$spread.name' },
          { use: 'template', as: 'said', text: 'You drew {{cards.0.name}} for {{args.spread}}.' },
        ],
        returns: ['spread', 'cards', 'said'],
      },
    ],
    boards: { wall: { layout: 'cards', image: 'image', flip: 'reversed', caption: '{{slot}}: {{name}}' } },
    schedules: [{ id: 'morning', description: 'A card each morning', cron: '0 8 * * *', taskPrompt: 'Draw one card.', tools: ['draw'], delivery: 'speak_next_session' }],
    settings: { reversals: { type: 'switch', label: 'Reversed cards', default: true } },
  };
}

/** The fixtures are ASCII, and the core has no TextEncoder in its types (ES2023, no DOM). */
async function folderWith(edit: (files: Map<string, Uint8Array | string>) => void = () => {}): Promise<PluginFolder> {
  const files = new Map<string, Uint8Array | string>([
    ['instructions.md', 'Draw when asked.'],
    ['data/cards.json', JSON.stringify(CARDS)],
    ['data/spreads.json', JSON.stringify(SPREADS)],
    ['img/sun.png', PNG],
    ['img/moon.png', PNG],
  ]);
  edit(files);
  return {
    bytes: async (path) => {
      const file = files.get(path);
      return file === undefined ? null : typeof file === 'string' ? Uint8Array.from(file, (char) => char.charCodeAt(0)) : file;
    },
    text: async (path) => {
      const file = files.get(path);
      return file === undefined ? null : typeof file === 'string' ? file : String.fromCharCode(...file);
    },
  };
}

/** The fixture's manifest with real (fake) hashes in. */
async function pinned(edit: (m: ReturnType<typeof manifest>) => void = () => {}): Promise<string> {
  const m = manifest();
  for (const asset of m.assets ?? []) asset.sha256 = await fakeSha(asset.url === undefined ? PNG : JPEG);
  edit(m);
  return JSON.stringify(m);
}

const OPTIONS: CheckPluginOptions = { sha256: fakeSha, appVersion: '1.0.0' };

async function problemsOf(text: string, folder?: PluginFolder, options: CheckPluginOptions = OPTIONS): Promise<readonly string[]> {
  const result = await checkPlugin(text, folder ?? (await folderWith()), options);
  return result.ok ? [] : result.problems;
}

describe('checkPlugin (P10-T01)', () => {
  it('passes a good plugin, with its data read and its cost estimated', async () => {
    const result = await checkPlugin(await pinned(), await folderWith(), OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes).toEqual([]);
    expect(result.plugin.data['cards']).toEqual(CARDS);
    expect(result.plugin.instructions).toBe('Draw when asked.');
    expect(result.plugin.assetBytes).toBe(PNG.length * 2 + JPEG.length);
    expect(result.plugin.promptTokens.idle).toBe(Math.ceil('Draws sky cards.'.length / 4));
    expect(result.plugin.promptTokens.used).toBeGreaterThan(result.plugin.promptTokens.idle);
  });

  // ── The done-when's six ──

  it('refuses a bad id', async () => {
    expect(await problemsOf(await pinned((m) => (m.id = 'Sky Cards')))).toEqual([
      'plugin.json, id: must be 2 to 24 characters: lowercase letters, digits and hyphens, starting with a letter.',
    ]);
  });

  it('refuses a missing file', async () => {
    const folder = await folderWith((files) => files.delete('data/spreads.json'));
    expect(await problemsOf(await pinned(), folder)).toEqual(['Table "spreads" ("data/spreads.json") is not in the folder.']);
    const noInstructions = await folderWith((files) => files.delete('instructions.md'));
    expect(await problemsOf(await pinned(), noInstructions)).toEqual(['The instructions file "instructions.md" is not in the folder.']);
    const noImage = await folderWith((files) => files.delete('img/moon.png'));
    expect(await problemsOf(await pinned(), noImage)).toEqual(['Asset "moon": "img/moon.png" is not in the folder.']);
  });

  it('refuses a wrong hash, and a wrong size, in the folder and at an address', async () => {
    const tampered = await folderWith((files) => files.set('img/sun.png', new Uint8Array([...PNG.slice(0, -1), 9])));
    expect(await problemsOf(await pinned(), tampered)).toEqual([`Asset "sun": img/sun.png has SHA-256 ${await fakeSha(new Uint8Array([...PNG.slice(0, -1), 9]))}, and the manifest says ${await fakeSha(PNG)}.`]);

    const longer = new Uint8Array([...JPEG, 7]);
    const fetched = await problemsOf(await pinned(), undefined, { ...OPTIONS, fetchAsset: async () => longer });
    expect(fetched).toEqual([
      `Asset "star": https://example.com/star.jpg is ${longer.length} bytes, and the manifest says ${JPEG.length}.`,
      `Asset "star": https://example.com/star.jpg has SHA-256 ${await fakeSha(longer)}, and the manifest says ${await fakeSha(JPEG)}.`,
    ]);
    // Without a fetcher an address is taken as listed: the app checks it when it downloads (ADR-70).
    expect(await problemsOf(await pinned())).toEqual([]);
  });

  it('refuses a tool naming a missing table', async () => {
    const text = await pinned((m) => {
      const step = m.tools[0]?.steps[1];
      if (step?.use === 'draw') step.table = 'cardz';
    });
    expect(await problemsOf(text)).toEqual(['Tool "draw", step 2 (draw): there is no table "cardz" in "data".']);
  });

  it('refuses an unknown primitive, and lists the ones there are', async () => {
    const text = await pinned((m) => {
      const steps = m.tools[0]?.steps as unknown[] | undefined;
      steps?.splice(1, 0, { use: 'shuffle', table: 'cards' });
    });
    expect(await problemsOf(text)).toEqual(['plugin.json, tools[0].steps[1].use: is not a primitive; the primitives are draw, roll, lookup, template, state, show.']);
  });

  it('refuses a newer format by name', async () => {
    expect(await problemsOf(await pinned((m) => ((m as { format: number }).format = 2)))).toEqual([
      'plugin.json is format 2, newer than this app reads (format 1): it needs a newer latentPresence.',
    ]);
    expect(await problemsOf(await pinned((m) => delete (m as { format?: number }).format))).toEqual([
      'plugin.json has no "format": this app reads format 1, so add "format": 1.',
    ]);
    expect(await problemsOf('{ "format": 1,')).toHaveLength(1);
  });

  // ── References ──

  it('follows references to arguments, settings and earlier steps', async () => {
    const text = await pinned((m) => {
      const tool = m.tools[0];
      if (tool === undefined) return;
      tool.steps = [
        { use: 'draw', as: 'cards', table: 'cards', slots: '$spread.positions', reversed: '$settings.upside' },
        { use: 'lookup', as: 'spread', table: 'spreads', key: '$args.which' },
        { use: 'template', as: 'said', text: '{{spread.colour}} and {{nothing}} and {{ bad path! }}' },
        { use: 'roll', as: 'die', dice: 'd6' },
        { use: 'template', as: 'said', text: '{{die.sum}} {{' },
      ];
      tool.returns = ['cards', 'gone'];
    });
    expect(await problemsOf(text)).toEqual([
      'Tool "draw", step 1 (draw), "slots": "spread.positions" reads step "spread" before it runs.',
      'Tool "draw", step 1 (draw), "reversed": "settings.upside" names a setting "upside" the plugin does not have.',
      'Tool "draw", step 2 (lookup), "key": "args.which" names a parameter "which" the tool does not have.',
      'Tool "draw", step 3 (template), "text": {{bad path!}} is not a path like {{name}} or {{spread.title}}.',
      'Tool "draw", step 3 (template), "text": "spread.colour": "colour" is not a field of "spreads".',
      'Tool "draw", step 3 (template), "text": "nothing" names nothing: not $args, $settings or an earlier step.',
      'Tool "draw", step 5 (template), "text": a "{{" or "}}" is not closed.',
      'Tool "draw", step 5 (template), "text": "die.sum": a roll has total and rolls, not "sum".',
      'Tool "draw", step 5 (template): an earlier step is already named "said".',
      'Tool "draw": returns "gone", which no step produces.',
    ]);
  });

  it('checks what a board shows against the table it comes from', async () => {
    const text = await pinned((m) => {
      m.boards = { wall: { layout: 'cards', image: 'picture', flip: 'upside', caption: '{{slot}}: {{title}}' } };
      const tool = m.tools[0];
      if (tool === undefined) return;
      tool.steps.push({ use: 'show', board: 'floor', items: '$cards' }, { use: 'show', board: 'wall', items: '$said' });
    });
    expect(await problemsOf(text)).toEqual([
      'Board "wall" (shown by Tool "draw", step 3 (show)): "image" names "picture", which is not a field of "cards".',
      'Board "wall" (shown by Tool "draw", step 3 (show)): "flip" names "upside", which is not a field of "cards" or of a drawn row.',
      'Board "wall" (shown by Tool "draw", step 3 (show)), "caption": {{title}} is not a field of "cards" or of a drawn row.',
      'Tool "draw", step 5 (show): there is no board "floor" in "boards".',
      'Tool "draw", step 6 (show): "items" must name an earlier draw or lookup step, like "$cards"; "$said" does not.',
    ]);
  });

  it('needs every image a board shows to be an asset', async () => {
    const folder = await folderWith((files) => files.set('data/cards.json', JSON.stringify([...CARDS, { id: 'comet', name: 'The Comet', image: 'comet' }])));
    expect(await problemsOf(await pinned(), folder)).toEqual(['Board "wall" (shown by Tool "draw", step 3 (show)): 1 row of "cards" names an image that is not an asset (the first: "comet").']);
  });

  it('checks a draw against its table and its slots', async () => {
    const text = await pinned((m) => {
      const tool = m.tools[0];
      if (tool === undefined) return;
      tool.steps = [
        { use: 'draw', as: 'cards', table: 'cards', count: 4 },
        { use: 'draw', as: 'two', table: 'cards', count: 3, slots: ['a', 'b'] },
        { use: 'lookup', as: 'spread', table: 'spreads', key: 'two', by: 'title' },
      ];
      tool.returns = ['cards'];
    });
    expect(await problemsOf(text)).toEqual([
      'Tool "draw", step 1 (draw): draws 4 from "cards", which has 3 rows.',
      'Tool "draw", step 2 (draw): draws 3 but names 2 slots.',
      'Tool "draw", step 3 (lookup): "title" is missing from every row of "spreads".',
    ]);
  });

  it('checks parameters, settings, schedules and duplicates', async () => {
    const text = await pinned((m) => {
      const tool = m.tools[0];
      if (tool === undefined) return;
      tool.parameters = {
        spread: { type: 'string', description: 'x', enumFrom: { table: 'spreads', column: 'key' } },
        count: { type: 'integer', description: 'x', enum: ['1'], default: 1.5 },
      };
      m.tools.push({ ...tool, parameters: { spread: { type: 'string', description: 'x' } } });
      m.settings = { mode: { type: 'choice', label: 'Mode', choices: ['a', 'b'], default: 'c' }, reversals: { type: 'switch', label: 'r', default: true } };
      m.schedules = [
        { id: 'a', description: 'x', cron: 'every morning', taskPrompt: '', tools: ['draw', 'fly', 'notes__read', 'plan_list', 'files__write_document'], delivery: 'notify' },
        { id: 'a', description: 'x', cron: '0 8 * * *', taskPrompt: '', delivery: 'notify' },
      ];
    });
    const problems = await problemsOf(text);
    expect(problems.slice(0, 6)).toEqual([
      'Two tools are named "draw".',
      'Two schedules have the id "a".',
      'Setting "mode": its default "c" is not one of its choices.',
      'Tool "draw", parameter "spread": "key" is missing from every row of "spreads".',
      'Tool "draw", parameter "count": only a string can have an "enum" or "enumFrom".',
      'Tool "draw", parameter "count": its default 1.5 is not a integer.',
    ]);
    expect(problems.slice(-3)).toEqual([
      expect.stringMatching(/^Schedule "a": "every morning" is not a cron expression this app reads \(.+\)\.$/),
      'Schedule "a": "fly" is none of the plugin\'s tools, "<server>__<tool>" for one of its MCP servers, or one of the app\'s (plan_list, schedule_list, files__<tool>).',
      'Schedule "a": "notes__read" is none of the plugin\'s tools, "<server>__<tool>" for one of its MCP servers, or one of the app\'s (plan_list, schedule_list, files__<tool>).',
    ]);
  });

  it('checks data files are tables', async () => {
    for (const [content, problem] of [
      ['{"rows": []}', 'Table "cards" ("data/cards.json") must be a JSON array of objects, one per row.'],
      ['[]', 'Table "cards" ("data/cards.json") has no rows.'],
      ['[{"id": "a"}, 3]', 'Table "cards" ("data/cards.json"): row 2 is not an object.'],
    ] as const) {
      const folder = await folderWith((files) => files.set('data/cards.json', content));
      expect((await problemsOf(await pinned(), folder))[0], content).toBe(problem);
    }
  });

  it('knows an image by its bytes, not its name', async () => {
    const folder = await folderWith((files) => files.set('img/sun.png', JPEG));
    const text = await pinned((m) => {
      const sun = m.assets?.[0];
      if (sun !== undefined) {
        sun.bytes = JPEG.length;
        sun.sha256 = '';
      }
    });
    const withHash = text.replace('"sha256":""', `"sha256":"${await fakeSha(JPEG)}"`);
    expect(await problemsOf(withHash, folder)).toEqual(['Asset "sun": img/sun.png is image/jpeg, and the manifest says image/png.']);
  });

  it('compares minApp with the running app', async () => {
    expect(await problemsOf(await pinned((m) => (m.minApp = '1.2.0')))).toEqual(['It needs latentPresence 1.2.0 or newer, and this is 1.0.0.']);
    expect(await problemsOf(await pinned((m) => (m.minApp = '1.2.0')), undefined, { sha256: fakeSha })).toEqual([]);
    expect([compareVersions('1.0.0', '1.0.0'), compareVersions('1.10.0', '1.9.9'), compareVersions('1.0.0-beta', '1.0.0'), compareVersions('0.9.0', '1.0.0')]).toEqual([0, 1, -1, -1]);
  });

  it('notes what is never used, without refusing it', async () => {
    const text = await pinned((m) => {
      m.boards = { ...m.boards, spare: { layout: 'list', line: '{{name}}' } };
      m.data = { ...m.data, extra: 'data/cards.json' };
    });
    const result = await checkPlugin(text, await folderWith(), OPTIONS);
    expect(result.ok && result.notes).toEqual(['Board "spare" is never shown by a tool.', 'Table "extra" is never read by a tool.']);
  });
});
