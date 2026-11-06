import { describe, expect, it } from 'vitest';
import { PluginManifestSchema, type JsonValue, type PluginManifestInput, type ToolCall } from '@latentpresence/protocol';
import { seededRandom } from '../idle/planner';
import { FakeMemoryStore } from '../memory/fake-store';
import { SelfNotes } from '../self/notes';
import { selfNoteTools } from '../self/tools';
import type { CheckedPlugin, PluginRow } from './check';
import { FakePluginHost } from './fake';
import { PLUGIN_STATE_CHAR_LIMIT, cryptoRandom, drawIndices, fill, pluginBlockName, pluginTools, type PluginLocalTool } from './runtime';

/**
 * The primitives, run (P10-T02, ADR-72 item 3). The tarot plugin itself runs end to end from disk in
 * `packages/plugin-tools` (the core reads no files); here, a small sky deck, uniformity, and the
 * plugin's state kept to itself.
 */

const CARDS: PluginRow[] = [
  { id: 'sun', name: 'The Sun', image: 'sun' },
  { id: 'moon', name: 'The Moon', image: 'moon' },
  { id: 'star', name: 'The Star', image: 'star' },
];
const SPREADS: PluginRow[] = [
  { id: 'one', name: 'One card', positions: ['Now'] },
  { id: 'two', name: 'Two cards', positions: ['Now', 'Next'] },
];

function plugin(edit: (m: PluginManifestInput & { tools: NonNullable<PluginManifestInput['tools']> }) => void = () => {}, id = 'sky'): CheckedPlugin {
  const m: PluginManifestInput & { tools: NonNullable<PluginManifestInput['tools']> } = {
    format: 1,
    id,
    name: 'Sky cards',
    version: '0.1.0',
    author: 'Test',
    licence: 'Apache-2.0',
    summary: 'Draws sky cards.',
    minApp: '1.0.0',
    instructions: 'instructions.md',
    data: { cards: 'data/cards.json', spreads: 'data/spreads.json' },
    tools: [
      {
        name: 'draw',
        description: 'Draws a spread.',
        parameters: { spread: { type: 'string', description: 'Which spread.', enumFrom: { table: 'spreads', column: 'id' }, required: true } },
        steps: [
          { use: 'lookup', as: 'spread', table: 'spreads', key: '$args.spread' },
          { use: 'draw', as: 'cards', table: 'cards', slots: '$spread.positions', reversed: '$settings.reversals' },
          { use: 'show', board: 'wall', items: '$cards', title: '$spread.name' },
        ],
        returns: ['spread', 'cards'],
      },
      {
        name: 'roll',
        description: 'Rolls dice.',
        parameters: { dice: { type: 'string', description: 'Dice notation.', default: 'd6' }, times: { type: 'integer', description: 'How many.', minimum: 1, maximum: 3 }, loud: { type: 'boolean', description: 'Say it loud.' } },
        steps: [
          { use: 'roll', as: 'result', dice: '$args.dice' },
          { use: 'template', as: 'said', text: 'You rolled {{result.total}} ({{result.rolls}}){{args.nowhere}}.' },
        ],
        returns: ['result', 'said'],
      },
      {
        name: 'remember',
        description: 'Keeps what was drawn.',
        parameters: { card: { type: 'string', description: 'A card.', required: true } },
        steps: [
          { use: 'state', op: 'append', key: 'history', value: '$args.card' },
          { use: 'state', as: 'history', op: 'get', key: 'history' },
        ],
        returns: ['history'],
      },
    ],
    boards: { wall: { layout: 'cards', image: 'image', flip: 'reversed', caption: '{{slot}}: {{name}}' } },
    settings: { reversals: { type: 'switch', label: 'Reversed cards', default: true } },
  };
  edit(m);
  return { manifest: PluginManifestSchema.parse(m), instructions: 'Draw when asked.', data: { cards: CARDS, spreads: SPREADS }, assetBytes: 0, promptTokens: { idle: 4, used: 40 } };
}

const CALL: ToolCall = { id: 'c1', name: 'x', arguments: {}, source: 'llm', requestedAt: '2026-11-06T12:00:00Z' };

function tool(tools: readonly PluginLocalTool[], name: string): (args: Record<string, JsonValue>) => Promise<JsonValue> {
  const found = tools.find((candidate) => candidate.definition.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return (args) => found.run(args, { call: CALL });
}

/** Pearson's chi-square of counts against a uniform expectation. */
function chiSquare(counts: readonly number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const expected = total / counts.length;
  return counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
}
/** The chi-square 0.999 quantile for 77 degrees of freedom (Wilson–Hilferty): a fair draw fails one run in a thousand. */
const CHI_77_P001 = 121.2;

describe('pluginTools (P10-T02)', () => {
  it('offers each tool as <plugin>__<tool>, with its choices from the data and its policy', () => {
    const tools = pluginTools(plugin(), new FakePluginHost());
    expect(tools.map((candidate) => [candidate.definition.name, candidate.pluginId, candidate.policy])).toEqual([
      ['sky__draw', 'sky', 'auto'],
      ['sky__roll', 'sky', 'auto'],
      ['sky__remember', 'sky', 'auto'],
    ]);
    expect(tools[0]?.definition.parameters).toEqual({
      type: 'object',
      properties: { spread: { type: 'string', description: 'Which spread.', enum: ['one', 'two'] } },
      required: ['spread'],
    });
    expect(tools[1]?.definition.parameters).toMatchObject({ properties: { dice: { default: 'd6' }, times: { minimum: 1, maximum: 3 } }, required: [] });
  });

  it('draws a spread, returns it, and shows it with reversed cards upside down', async () => {
    const host = new FakePluginHost({ seed: 7 });
    const result = (await tool(pluginTools(plugin(), host), 'sky__draw')({ spread: 'two' })) as { spread: PluginRow; cards: PluginRow[] };
    expect(result.spread).toEqual(SPREADS[1]);
    expect(result.cards.map((card) => card['slot'])).toEqual(['Now', 'Next']);
    expect(new Set(result.cards.map((card) => card['id'])).size).toBe(2);
    for (const card of result.cards) {
      expect(CARDS).toContainEqual({ id: card['id'], name: card['name'], image: card['image'] });
      expect(typeof card['reversed']).toBe('boolean');
    }
    expect(host.shown).toEqual([
      {
        pluginId: 'sky',
        board: 'wall',
        layout: 'cards',
        where: 'screen',
        title: 'Two cards',
        items: result.cards.map((card) => ({ caption: `${String(card['slot'])}: ${String(card['name'])}`, image: card['image'], flip: card['reversed'] })),
      },
    ]);
  });

  it('holds the model to the parameters, and says what was wrong', async () => {
    const tools = pluginTools(plugin(), new FakePluginHost());
    expect(await tool(tools, 'sky__draw')({})).toEqual({ error: 'draw needs "spread": Which spread.' });
    expect(await tool(tools, 'sky__draw')({ spread: 'five' })).toEqual({ error: '"spread" must be one of: one, two. "five" is not.' });
    expect(await tool(tools, 'sky__roll')({ times: 5 })).toEqual({ error: '"times" must be at most 3.' });
    expect(await tool(tools, 'sky__roll')({ times: 1.5 })).toEqual({ error: '"times" must be a whole number, not 1.5.' });
    expect(await tool(tools, 'sky__roll')({ loud: 'yes' })).toEqual({ error: '"loud" must be a boolean, not "yes".' });
    // What small models send often enough: numbers and booleans as strings.
    expect(await tool(tools, 'sky__roll')({ times: '2', loud: 'true' })).toMatchObject({ result: { total: expect.any(Number) } });
  });

  it('rolls dice, with a default, and refuses what is not dice', async () => {
    const tools = pluginTools(plugin(), new FakePluginHost({ seed: 3 }));
    const roll = tool(tools, 'sky__roll');
    const plain = (await roll({})) as { result: { total: number; rolls: number[] }; said: string };
    expect(plain.result.rolls).toHaveLength(1);
    expect(plain.said).toBe(`You rolled ${plain.result.total} (${plain.result.rolls[0]}).`);
    for (let i = 0; i < 200; i += 1) {
      const { result } = (await roll({ dice: '3d6+1' })) as { result: { total: number; rolls: number[] } };
      expect(result.rolls).toHaveLength(3);
      expect(result.rolls.every((value) => value >= 1 && value <= 6)).toBe(true);
      expect(result.total).toBe(result.rolls.reduce((a, b) => a + b, 0) + 1);
    }
    expect(await roll({ dice: '0d6' })).toEqual({ error: '"0d6" is not dice to roll; write it like d20, 3d6 or 2d10+1.' });
    expect(await roll({ dice: 'a handful' })).toEqual({ error: '"a handful" is not dice to roll; write it like d20, 3d6 or 2d10+1.' });
  });

  it('says what a lookup could have found', async () => {
    const tools = pluginTools(
      plugin((m) => {
        const draw = m.tools[0];
        if (draw !== undefined) draw.parameters = { spread: { type: 'string', description: 'Which spread.', required: true } };
      }),
      new FakePluginHost(),
    );
    expect(await tool(tools, 'sky__draw')({ spread: 'three' })).toEqual({ error: 'There is no "three" in spreads. The choices are: one, two.' });
  });

  it('follows the reversals setting: half the cards by default, none when switched off', async () => {
    const count = async (settings: Record<string, JsonValue>) => {
      const host = new FakePluginHost({ seed: 11, settings });
      const draw = tool(pluginTools(plugin(), host), 'sky__draw');
      let reversed = 0;
      for (let i = 0; i < 10_000; i += 1) {
        const { cards } = (await draw({ spread: 'two' })) as { cards: PluginRow[] };
        reversed += cards.filter((card) => card['reversed'] === true).length;
      }
      return reversed / 20_000;
    };
    expect(Math.abs((await count({})) - 0.5)).toBeLessThan(0.015);
    expect(await count({ reversals: false })).toBe(0);
    // A setting of the wrong type is the manifest's default, not a crash.
    expect(Math.abs((await count({ reversals: 'often' })) - 0.5)).toBeLessThan(0.015);
  });

  it('reverses at a declared rate', async () => {
    const tools = pluginTools(
      plugin((m) => {
        const step = m.tools[0]?.steps[1];
        if (step?.use === 'draw') step.reversed = 0.25;
      }),
      new FakePluginHost({ seed: 5 }),
    );
    let reversed = 0;
    for (let i = 0; i < 10_000; i += 1) reversed += ((await tool(tools, 'sky__draw')({ spread: 'one' })) as { cards: PluginRow[] }).cards.filter((card) => card['reversed'] === true).length;
    expect(Math.abs(reversed / 10_000 - 0.25)).toBeLessThan(0.015);
  });
});

describe('drawIndices: a fair shuffle (P10-T02)', () => {
  it('draws one card of 78 uniformly over 100,000 draws', () => {
    const random = seededRandom(78);
    const counts = Array.from({ length: 78 }, () => 0);
    for (let i = 0; i < 100_000; i += 1) counts[drawIndices(78, 1, random)[0]!]! += 1;
    expect(chiSquare(counts)).toBeLessThan(CHI_77_P001);
  });

  it('never repeats a card within a draw, and every position of a spread is uniform', () => {
    const random = seededRandom(1909);
    const byPosition = Array.from({ length: 10 }, () => Array.from({ length: 78 }, () => 0));
    for (let i = 0; i < 100_000; i += 1) {
      const drawn = drawIndices(78, 10, random);
      expect(new Set(drawn).size).toBe(10);
      drawn.forEach((card, position) => (byPosition[position]![card]! += 1));
    }
    for (const counts of byPosition) expect(chiSquare(counts)).toBeLessThan(CHI_77_P001);
  });

  it('would catch the classic biased shuffle', () => {
    // Swapping with any card, not only those not yet placed, favours some orders: the test above
    // must be able to see a bias of that kind, or it proves nothing.
    const random = seededRandom(2);
    const counts = Array.from({ length: 6 }, () => 0);
    for (let i = 0; i < 100_000; i += 1) {
      const deck = [0, 1, 2];
      for (let k = 0; k < 3; k += 1) {
        const j = Math.floor(random() * 3);
        [deck[k], deck[j]] = [deck[j]!, deck[k]!];
      }
      counts[deck[0]! * 2 + (deck[1]! > deck[2]! ? 1 : 0)]! += 1;
    }
    const fair = Array.from({ length: 6 }, () => 0);
    for (let i = 0; i < 100_000; i += 1) {
      const deck = drawIndices(3, 3, random);
      fair[deck[0]! * 2 + (deck[1]! > deck[2]! ? 1 : 0)]! += 1;
    }
    expect(chiSquare(counts)).toBeGreaterThan(1000);
    expect(chiSquare(fair)).toBeLessThan(20.5); // the 0.999 quantile for 5 degrees of freedom
  });

  it('stays in range when the generator returns its largest value', () => {
    expect(drawIndices(5, 5, () => 0.999_999_999_9).toSorted()).toEqual([0, 1, 2, 3, 4]);
  });

  it('takes its randomness from the platform', () => {
    const values = Array.from({ length: 100 }, cryptoRandom);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(values).size).toBe(100);
  });
});

describe('a plugin\'s state (P10-T02, ADR-72 item 5)', () => {
  it('keeps it in its own system block, not editable by her', async () => {
    const host = new FakePluginHost();
    const remember = tool(pluginTools(plugin(), host), 'sky__remember');
    await remember({ card: 'The Sun' });
    expect(await remember({ card: 'The Moon' })).toEqual({ history: ['The Sun', 'The Moon'] });
    const blocks = await host.store.readBlocks('alice');
    expect(blocks).toEqual([{ characterId: 'alice', name: '_plugin:sky', content: '{"history":["The Sun","The Moon"]}', updatedAt: '2026-11-06T12:00:00.000Z', editableByCharacter: false }]);
    expect(pluginBlockName('sky')).toBe('_plugin:sky');
  });

  it('is read by no other plugin and no other character', async () => {
    const store = new FakeMemoryStore();
    const run = (characterId: string, id: string) => tool(pluginTools(plugin(() => {}, id), new FakePluginHost({ store, characterId })), `${id}__remember`);
    await run('alice', 'sky')({ card: 'The Sun' });
    expect(await run('alice', 'moon')({ card: 'The Moon' })).toEqual({ history: ['The Moon'] });
    expect(await run('theo', 'sky')({ card: 'The Star' })).toEqual({ history: ['The Star'] });
    expect(await run('alice', 'sky')({ card: 'The Star' })).toEqual({ history: ['The Sun', 'The Star'] });
    expect((await store.readBlocks('alice')).map((block) => block.name)).toEqual(['_plugin:moon', '_plugin:sky']);
    expect((await store.readBlocks('theo')).map((block) => block.name)).toEqual(['_plugin:sky']);
  });

  it('refuses to grow past what the companion keeps, and saves nothing then', async () => {
    const host = new FakePluginHost();
    const remember = tool(pluginTools(plugin(), host), 'sky__remember');
    // `{"history":["…"]}` is 16 characters around the card: 14 under the limit, and the next card does not fit.
    await remember({ card: 'x'.repeat(PLUGIN_STATE_CHAR_LIMIT - 30) });
    const before = await host.store.readBlocks('alice');
    expect(await remember({ card: 'one more card' })).toEqual({ error: `The plugin's memory for this character is full (${PLUGIN_STATE_CHAR_LIMIT} characters); nothing was saved.` });
    expect(await host.store.readBlocks('alice')).toEqual(before);
  });

  it('starts again from a block that is not its JSON', async () => {
    const host = new FakePluginHost();
    await host.store.writeBlock({ characterId: 'alice', name: '_plugin:sky', content: 'not json', updatedAt: '2026-11-06T12:00:00Z', editableByCharacter: false });
    expect(await tool(pluginTools(plugin(), host), 'sky__remember')({ card: 'The Sun' })).toEqual({ history: ['The Sun'] });
  });

  it('is invisible to her notes and her self-editing tools, which cannot write it either', async () => {
    const host = new FakePluginHost();
    await tool(pluginTools(plugin(), host), 'sky__remember')({ card: 'The Sun' });
    const notes = new SelfNotes({ store: host.store, characterId: 'alice' });
    await notes.load();
    expect(notes.notes()).toEqual([]);
    const [read, write] = selfNoteTools(notes);
    expect(await read?.run({ name: '_plugin:sky' }, { call: CALL })).toEqual({ error: 'You have no note called "_plugin:sky".', notes: [] });
    expect(await write?.run({ name: '_plugin:sky', content: 'overwritten' }, { call: CALL })).toMatchObject({ error: expect.any(String) });
    expect((await host.store.readBlocks('alice')).find((block) => block.name === '_plugin:sky')?.content).toBe('{"history":["The Sun"]}');
  });
});

describe('fill', () => {
  it('fills paths, joins lists, and leaves nothing for what names nothing', () => {
    expect(fill('{{a.b}} / {{ list }} / {{missing.deep}} / {{n}}', { a: { b: 'x' }, list: ['p', 'q'], n: 0 })).toBe('x / p, q /  / 0');
  });
});
