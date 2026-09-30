import type { JsonValue, LLMProvider, LlmRequest, LlmStreamChunk, ToolCall } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore } from '../memory/fake-store';
import { MemoryKernel } from '../memory/kernel';
import { withLocalTools } from '../self/tools';
import { Plans } from './plans';
import { planTools } from './tools';

const NOW = new Date('2026-09-30T12:00:00.000Z');

function setup() {
  const store = new FakeMemoryStore({ now: () => NOW });
  const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: null, now: () => NOW });
  const plans = new Plans({ store, characterId: 'alice', followUps: kernel, now: () => NOW });
  const tools = planTools(plans);
  const run = async (name: string, args: Record<string, JsonValue>): Promise<JsonValue> => {
    const tool = tools.find((candidate) => candidate.definition.name === name);
    if (tool === undefined) throw new Error(`no ${name}`);
    return tool.run(args);
  };
  return { store, plans, tools, run };
}

const GARDEN = {
  title: 'Vegetable garden',
  goal: 'Easy vegetables by spring.',
  phases: [
    { title: 'Prepare the bed', tasks: ['Pick a sunny spot', 'Dig in compost'] },
    { title: 'Plant', tasks: ['Buy seedlings'] },
  ],
};

describe('plan tools (P4-T07, ADR-41)', () => {
  it('are named without dots and each asks only for what it needs', () => {
    const { tools } = setup();
    expect(tools.map((tool) => [tool.definition.name, (tool.definition.parameters as { required?: string[] }).required ?? []])).toEqual([
      ['plan_create', ['title']],
      ['plan_update', ['plan']],
      ['plan_list', []],
      ['plan_follow_up', ['plan']],
    ]);
  });

  it('create saves the plan and hands back a summary she can go on', async () => {
    const { store, run } = setup();
    const result = await run('plan_create', GARDEN);
    const [saved] = await store.listPlans('alice');
    expect(result).toEqual({
      saved: {
        id: saved?.id,
        title: 'Vegetable garden',
        goal: 'Easy vegetables by spring.',
        status: 'active',
        phases: [
          { title: 'Prepare the bed', tasks: ['Pick a sunny spot', 'Dig in compost'] },
          { title: 'Plant', tasks: ['Buy seedlings'] },
        ],
      },
    });
  });

  it('update by title marks a task done; list shows it', async () => {
    const { run } = setup();
    await run('plan_create', GARDEN);
    const updated = await run('plan_update', { plan: 'Vegetable garden', task_updates: [{ task: 'Dig in compost', status: 'done' }] });
    expect(updated).toMatchObject({ saved: { phases: [{ tasks: ['Pick a sunny spot', 'Dig in compost (done)'] }, { tasks: ['Buy seedlings'] }] } });
    expect(await run('plan_list', {})).toMatchObject({ plans: [{ title: 'Vegetable garden' }] });
  });

  it('list leaves archived plans out unless asked', async () => {
    const { run } = setup();
    await run('plan_create', { title: 'Old', status: 'archived' });
    expect(await run('plan_list', {})).toEqual({ plans: [] });
    expect(await run('plan_list', { include_archived: true })).toMatchObject({ plans: [{ title: 'Old' }] });
  });

  it('answers a malformed or empty call with a sentence, never a throw', async () => {
    const { run } = setup();
    expect(await run('plan_create', { goal: 'no title' })).toEqual({ error: expect.stringContaining('title') });
    await run('plan_create', GARDEN);
    expect(await run('plan_update', { plan: 'Vegetable garden' })).toEqual({ error: expect.stringContaining('Say what changed') });
    expect(await run('plan_update', { plan: 'Nope', goal: 'x' })).toEqual({ error: expect.stringContaining('There is no plan "Nope"') });
    expect(await run('plan_follow_up', { plan: 'Vegetable garden' })).toEqual({ error: expect.stringContaining('YYYY-MM-DD') });
  });

  it('reads an outline sent as a JSON string, as glm-5.2:cloud once did, and says what is wrong with one it cannot read', async () => {
    const { store, run } = setup();
    await run('plan_create', { ...GARDEN, phases: JSON.stringify(GARDEN.phases) });
    expect((await store.listPlans('alice'))[0]?.phases.map((phase) => phase.title)).toEqual(['Prepare the bed', 'Plant']);
    expect(await run('plan_update', { plan: 'Vegetable garden', task_updates: JSON.stringify([{ task: 'Buy seedlings', status: 'done' }]) })).toMatchObject({ saved: { phases: [{}, { tasks: ['Buy seedlings (done)'] }] } });
    expect(await run('plan_update', { plan: 'Vegetable garden', phases: 'first dig, then plant' })).toEqual({ error: expect.stringMatching(/^Not saved — phases: /u) });
  });

  it('follow_up adds a day, and cancel drops that day or every one', async () => {
    const { store, run } = setup();
    await run('plan_create', GARDEN);
    expect(await run('plan_follow_up', { plan: 'Vegetable garden', on: '2026-10-15', about: 'whether the seedlings are in' })).toEqual({
      follow_up: { plan: 'Vegetable garden', on: '2026-10-15', about: 'whether the seedlings are in' },
    });
    await run('plan_follow_up', { plan: 'Vegetable garden', on: '2026-10-05', about: 'the clearing' });
    expect(await store.currentFacts('alice')).toHaveLength(2);
    expect(await run('plan_follow_up', { plan: 'Vegetable garden', on: '2026-10-05', cancel: true })).toEqual({ cancelled: { plan: 'Vegetable garden', on: '2026-10-05' } });
    expect(await store.currentFacts('alice')).toHaveLength(1);
    expect(await run('plan_follow_up', { plan: 'Vegetable garden', cancel: true })).toEqual({ cancelled: { plan: 'Vegetable garden', on: 'every day' } });
    expect(await store.currentFacts('alice')).toEqual([]);
  });

  it('run through withLocalTools: "let\'s plan a vegetable garden" ends with a saved plan and words', async () => {
    const { store, plans, tools } = setup();
    const requests: LlmRequest[] = [];
    const call: ToolCall = { id: 'c1', name: 'plan_create', arguments: GARDEN, source: 'llm', requestedAt: NOW.toISOString() };
    const rounds: LlmStreamChunk[][] = [
      [{ type: 'tool-call', call }, { type: 'finish', reason: 'tool-calls', usage: null }],
      [{ type: 'text-delta', text: 'Saved it. Where gets the most sun?' }, { type: 'finish', reason: 'stop', usage: null }],
    ];
    const llm: LLMProvider = {
      id: 'scripted',
      listModels: async () => [],
      async *stream(request) {
        requests.push(request);
        yield* rounds[requests.length - 1] ?? [];
      },
    };
    const text: string[] = [];
    for await (const chunk of withLocalTools(llm, () => tools).stream({ modelId: 'm', messages: [{ role: 'user', content: "Let's plan a vegetable garden." }], tools: [], temperature: null, maxOutputTokens: null })) {
      if (chunk.type === 'text-delta') text.push(chunk.text);
    }
    expect(text.join('')).toBe('Saved it. Where gets the most sun?');
    expect(await store.listPlans('alice')).toEqual([expect.objectContaining({ title: 'Vegetable garden', version: 1 })]);
    expect(plans.snapshot().focusId).toBe(plans.snapshot().plans[0]?.id);
  });
});
