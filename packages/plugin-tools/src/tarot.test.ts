import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore, FakePluginHost, pluginTools, type CheckedPlugin, type PluginRow } from '@latentpresence/core';
import type { ToolCall } from '@latentpresence/protocol';
import { checkFolder } from './run';

/**
 * The tarot draft's tool, end to end (P10-T02): read and checked from `plugins/tarot` as installing
 * will, compiled, and run over a fake store with seeded draws. What the board shows is what the model
 * reads, and a reversed card is turned upside down on it (Rick, 2026-11-06).
 */
const TAROT = fileURLToPath(new URL('../../../plugins/tarot', import.meta.url));
const CALL: ToolCall = { id: 'c1', name: 'tarot__draw_spread', arguments: {}, source: 'llm', requestedAt: '2026-11-06T12:00:00Z' };

async function tarot(): Promise<CheckedPlugin> {
  const result = await checkFolder(TAROT);
  if (!result.ok) throw new Error(result.problems.join('\n'));
  return result.plugin;
}

describe('tarot__draw_spread (P10-T02)', () => {
  it('is offered with the three spreads to choose from', async () => {
    const [tool, ...rest] = pluginTools(await tarot(), new FakePluginHost());
    expect(rest).toEqual([]);
    expect(tool?.definition.name).toBe('tarot__draw_spread');
    expect(tool?.policy).toBe('auto');
    expect(tool?.definition.parameters).toMatchObject({ properties: { spread: { type: 'string', enum: ['single', 'three', 'celtic_cross'] } }, required: ['spread'] });
  });

  it('lays out a Celtic cross: ten different cards in their positions, on the wall as the model reads them', async () => {
    const plugin = await tarot();
    const host = new FakePluginHost({ seed: 1909 });
    const [tool] = pluginTools(plugin, host);
    const result = (await tool?.run({ spread: 'celtic_cross' }, { call: CALL })) as { spread: PluginRow; cards: PluginRow[] };

    expect(result.spread['name']).toBe('The Celtic cross');
    expect(result.cards.map((card) => card['slot'])).toEqual(plugin.data['spreads']?.find((spread) => spread['id'] === 'celtic_cross')?.['positions']);
    expect(new Set(result.cards.map((card) => card['number'])).size).toBe(10);

    expect(host.shown).toHaveLength(1);
    const shown = host.shown[0];
    expect(shown).toMatchObject({ pluginId: 'tarot', board: 'spread', layout: 'cards', where: 'screen', title: 'The Celtic cross' });
    expect(shown?.items).toEqual(
      result.cards.map((card) => ({ caption: `${String(card['slot'])}: ${String(card['name'])}`, image: `card-${String(card['number'])}`, flip: card['reversed'] })),
    );
    for (const item of shown?.items ?? []) expect(plugin.manifest.assets.some((asset) => asset.id === item.image)).toBe(true);
  });

  it("hands the model each card's upright and reversed meaning with it (P10-T06)", async () => {
    const [tool] = pluginTools(await tarot(), new FakePluginHost({ seed: 7 }));
    const result = (await tool?.run({ spread: 'three' }, { call: CALL })) as { cards: PluginRow[] };
    for (const card of result.cards) {
      expect(typeof card['upright']).toBe('string');
      expect(typeof card['reversed_meaning']).toBe('string');
      expect(typeof card['reversed']).toBe('boolean');
    }
  });

  it('has a short meaning each way for all 78 cards, every one its own (P10-T06)', async () => {
    const cards = (await tarot()).data['cards'] ?? [];
    expect(cards).toHaveLength(78);
    const all: string[] = [];
    for (const card of cards) {
      for (const key of ['upright', 'reversed_meaning']) {
        const meaning = card[key];
        const label = `${String(card['name'])} ${key}`;
        expect(typeof meaning, label).toBe('string');
        // Short enough that a small model reads it as a cue, not a script.
        expect(String(meaning).length, label).toBeLessThanOrEqual(100);
        all.push(String(meaning));
      }
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('turns reversed cards upside down, about half of them, and none when reversals are off', async () => {
    const plugin = await tarot();
    const flips = async (settings: Record<string, boolean>) => {
      const host = new FakePluginHost({ seed: 22, settings, store: new FakeMemoryStore() });
      const [tool] = pluginTools(plugin, host);
      for (let i = 0; i < 2_000; i += 1) await tool?.run({ spread: 'three' }, { call: CALL });
      const items = host.shown.flatMap((display) => display.items);
      return items.filter((item) => item.flip).length / items.length;
    };
    expect(Math.abs((await flips({})) - 0.5)).toBeLessThan(0.03);
    expect(await flips({ reversals: false })).toBe(0);
  });

  it('says so when the model asks for a spread there is not', async () => {
    const [tool] = pluginTools(await tarot(), new FakePluginHost());
    expect(await tool?.run({ spread: 'horseshoe' }, { call: CALL })).toEqual({ error: '"spread" must be one of: single, three, celtic_cross. "horseshoe" is not.' });
  });
});
