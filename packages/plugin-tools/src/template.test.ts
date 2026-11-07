import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakePluginHost, pluginTools, type PluginRow } from '@latentpresence/core';
import type { ToolCall } from '@latentpresence/protocol';
import { checkFolder } from './run';

/**
 * `plugins/template` (P10-T09), the folder the guide says to copy: it must not only pass the check
 * but do what the guide says its tools do.
 */
const TEMPLATE = fileURLToPath(new URL('../../../plugins/template', import.meta.url));
const CALL: ToolCall = { id: 'c1', name: 'template__draw_fortune', arguments: {}, source: 'llm', requestedAt: '2026-11-07T12:00:00Z' };

describe('the template plugin', () => {
  it('draws a fortune onto the whiteboard and rolls the dice it is given', async () => {
    const result = await checkFolder(TEMPLATE);
    if (!result.ok) throw new Error(result.problems.join('\n'));
    const host = new FakePluginHost({ seed: 3 });
    const [draw, roll] = pluginTools(result.plugin, host);
    expect([draw?.definition.name, roll?.definition.name]).toEqual(['template__draw_fortune', 'template__roll_dice']);

    const drawn = (await draw?.run({}, { call: CALL })) as { fortune: PluginRow[] };
    expect(drawn.fortune).toHaveLength(1);
    expect(host.shown[0]).toMatchObject({ pluginId: 'template', layout: 'list', where: 'whiteboard', title: 'Your fortune', items: [{ caption: drawn.fortune[0]?.['text'] }] });

    const rolled = (await roll?.run({ dice: '3d6' }, { call: CALL })) as { roll: { total: number; rolls: number[] }; said: string };
    expect(rolled.roll.rolls).toHaveLength(3);
    expect(rolled.said).toBe(`3d6: ${rolled.roll.total}`);
    const plain = (await roll?.run({}, { call: CALL })) as { said: string };
    expect(plain.said).toMatch(/^d6: [1-6]$/u);
  });
});
