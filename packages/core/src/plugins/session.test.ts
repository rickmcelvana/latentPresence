import { describe, expect, it } from 'vitest';
import { PersonaSchema, PluginManifestSchema, type LLMProvider, type LlmRequest, type LlmStreamChunk, type PluginManifestInput } from '@latentpresence/protocol';
import alice from '../../../../personas/alice.persona.json' with { type: 'json' };
import { renderSystemPrompt } from '../persona/prompt';
import { withLocalTools } from '../self/tools';
import type { CheckedPlugin } from './check';
import { FakePluginHost } from './fake';
import { pluginTools } from './runtime';
import { PLUGIN_BUDGET, PluginSession, USE_PLUGIN_TOOL, pluginBudget, type EnabledPlugin } from './session';

/**
 * Plugins loaded when needed (P10-T04, ADR-72 item 4): with five enabled, a request carries five
 * lines and one extra tool until one is used, then that plugin's tools, in the same answer.
 */

const AT = '2026-11-06T12:00:00.000Z';

function plugin(id: string, tools: readonly string[]): CheckedPlugin {
  const manifest: PluginManifestInput = {
    format: 1,
    id,
    name: `${id[0]?.toUpperCase()}${id.slice(1)}`,
    version: '0.1.0',
    author: 'Test',
    licence: 'Apache-2.0',
    summary: `Does ${id} things; use it when someone asks for ${id}.`,
    minApp: '1.0.0',
    instructions: 'instructions.md',
    data: { rows: 'data/rows.json' },
    tools: tools.map((name) => ({ name, description: `${name} for ${id}.`, steps: [{ use: 'draw', as: 'row', table: 'rows' }], returns: ['row'] })),
  };
  return { manifest: PluginManifestSchema.parse(manifest), instructions: `How to use ${id}: carefully.`, data: { rows: [{ id: 'a', name: 'A' }] }, assetBytes: 0, promptTokens: { idle: 10, used: 50 } };
}

function enabled(ids: readonly (readonly [string, readonly string[], boolean?])[]): EnabledPlugin[] {
  const host = new FakePluginHost();
  return ids.map(([id, tools, always]) => {
    const checked = plugin(id, tools);
    return { plugin: checked, tools: pluginTools(checked, host), always: always ?? false };
  });
}

const FIVE = enabled([
  ['tarot', ['draw_spread']],
  ['dice', ['roll']],
  ['office', ['add_row', 'new_sheet', 'read_sheet']],
  ['plants', ['care']],
  ['trivia', ['question']],
]);

function scripted(rounds: readonly (readonly LlmStreamChunk[])[]): LLMProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    id: 'scripted',
    requests,
    listModels: async () => [],
    async *stream(request) {
      requests.push(request);
      yield* rounds[requests.length - 1] ?? [{ type: 'finish', reason: 'stop', usage: null }];
    },
  };
}

const call = (name: string, args: Record<string, string>): LlmStreamChunk => ({ type: 'tool-call', call: { id: `c-${name}`, name, arguments: args, source: 'llm', requestedAt: AT } });
const FINISH: LlmStreamChunk = { type: 'finish', reason: 'stop', usage: null };

describe('PluginSession (P10-T04)', () => {
  it('offers one line each and use_plugin, then that plugin\'s tools in the next round of the same answer', async () => {
    const session = new PluginSession(FIVE);
    const persona = PersonaSchema.parse(alice);
    const system = renderSystemPrompt(persona, { now: new Date(AT), userName: null, plugins: session.promptContext() });
    const lines = system.split('\n');
    const section = lines.slice(lines.indexOf('YOUR PLUGINS'));
    expect(section.filter((line) => /^- (tarot|dice|office|plants|trivia): /.test(line))).toHaveLength(5);
    expect(system).not.toContain('How to use');

    const llm = scripted([
      [call(USE_PLUGIN_TOOL, { id: 'tarot' }), FINISH],
      [call('tarot__draw_spread', {}), FINISH],
      [{ type: 'text-delta', text: 'The Fool.' }, FINISH],
    ]);
    const results: unknown[] = [];
    const wrapped = withLocalTools(llm, () => session.tools(), { onCall: (_call, result) => results.push(result) });
    for await (const chunk of wrapped.stream({ modelId: 'm', messages: [{ role: 'system', content: system }, { role: 'user', content: 'Read my cards?' }], tools: [], temperature: null, maxOutputTokens: null })) void chunk;

    const names = llm.requests.map((request) => request.tools.map((tool) => tool.name));
    expect(names[0]).toEqual([USE_PLUGIN_TOOL]);
    expect(names[1]).toEqual([USE_PLUGIN_TOOL, 'tarot__draw_spread']);
    expect(llm.requests[0]?.tools[0]?.parameters).toMatchObject({ properties: { id: { enum: ['tarot', 'dice', 'office', 'plants', 'trivia'] } } });
    expect(llm.requests[1]?.tools[0]?.parameters).toMatchObject({ properties: { id: { enum: ['dice', 'office', 'plants', 'trivia'] } } });
    expect(results[0]).toEqual({ using: 'Tarot', tools: ['tarot__draw_spread'], instructions: 'How to use tarot: carefully.' });
    expect(results[1]).toMatchObject({ row: [{ id: 'a', slot: 1 }] });

    // The next turn's prompt: four left to start, tarot's instructions in full.
    const next = session.promptContext();
    expect(next?.available.map((entry) => entry.id)).toEqual(['dice', 'office', 'plants', 'trivia']);
    expect(renderSystemPrompt(persona, { now: new Date(AT), userName: null, plugins: next })).toContain('PLUGIN IN USE: TAROT\nHow to use tarot: carefully.');
  });

  it('starts an always-loaded plugin in use, and drops use_plugin once every plugin is', async () => {
    const session = new PluginSession(enabled([['office', ['add_row'], true], ['dice', ['roll']]]));
    expect(session.inUse()).toEqual(['office']);
    expect(session.tools().map((tool) => tool.definition.name)).toEqual([USE_PLUGIN_TOOL, 'office__add_row']);
    const use = session.tools()[0];
    await use?.run({ id: 'dice' }, { call: { id: 'c', name: USE_PLUGIN_TOOL, arguments: {}, source: 'llm', requestedAt: AT } });
    expect(session.tools().map((tool) => tool.definition.name)).toEqual(['office__add_row', 'dice__roll']);
  });

  it('says which plugins there are when the model names one it does not have, and takes a name for an id', async () => {
    const session = new PluginSession(FIVE);
    const use = session.tools()[0];
    const ctx = { call: { id: 'c', name: USE_PLUGIN_TOOL, arguments: {}, source: 'llm' as const, requestedAt: AT } };
    expect(await use?.run({ id: 'astrology' }, ctx)).toEqual({ error: 'You have no plugin "astrology". Yours are: tarot, dice, office, plants, trivia.' });
    expect(await use?.run({ id: 'Dice' }, ctx)).toMatchObject({ using: 'Dice' });
    expect(await use?.run({ id: 'dice' }, ctx)).toMatchObject({ using: 'Dice', note: 'It was already in use.' });
  });

  it('leaves the prompt as it was with no plugin enabled', () => {
    const persona = PersonaSchema.parse(alice);
    const session = new PluginSession([]);
    expect(session.promptContext()).toBeNull();
    expect(session.tools()).toEqual([]);
    expect(renderSystemPrompt(persona, { now: new Date(AT), userName: null, plugins: session.promptContext() })).toBe(renderSystemPrompt(persona, { now: new Date(AT), userName: null }));
  });
});

function cost(name: string, tools: number, always: boolean) {
  return { name, tools, promptTokens: { idle: 30, used: 400 }, always };
}

describe('pluginBudget (P10-T04)', () => {

  it('counts a line per unused plugin and everything of an always-loaded one, with use_plugin while any is unused', () => {
    expect(pluginBudget([cost('Tarot', 1, false), cost('Dice', 1, false)], 'Alice')).toEqual({ everyRequest: 60, tools: 1, warnings: [] });
    expect(pluginBudget([cost('Office', 6, true), cost('Dice', 1, false)], 'Alice')).toEqual({ everyRequest: 460, tools: 7, warnings: [] });
    expect(pluginBudget([cost('Office', 6, true)], 'Alice').tools).toBe(6);
  });

  it('warns past the measured limits, and refuses nothing', () => {
    const many = pluginBudget([cost('Office', PLUGIN_BUDGET.alwaysTools, true), cost('Notes', 1, true)], 'Theo');
    expect(many.tools).toBe(PLUGIN_BUDGET.alwaysTools + 1);
    expect(many.warnings[0]).toBe(
      `Theo's plugins offer ${PLUGIN_BUDGET.alwaysTools + 1} tools in every request, more than the ${PLUGIN_BUDGET.alwaysTools} the app was measured with. Setting some to load only when needed keeps the list shorter.`,
    );
    const wordy = pluginBudget(Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, tools: 1, promptTokens: { idle: 30, used: 600 }, always: true })), 'Alice');
    expect(wordy.warnings).toEqual([
      `Alice's plugins add about ${5 * 630} tokens to every request (an estimate), more than twice her own prompt. Setting some to load only when needed saves most of that, at the cost of a slower first use.`,
    ]);
  });
});
