import { describe, expect, it } from 'vitest';
import { FakeMemoryStore, Schedules, agentExecutor, attachScheduler, type LocalTool } from '@latentpresence/core';
import { PluginManifestSchema, type LLMProvider, type PluginManifest } from '@latentpresence/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings';
import { pluginAdditions, pluginOffers, pluginServerId, presetRequest, scheduleOwners, withHttpServer, withOfferAnswer, withoutPluginOffers } from './offers';

/** What a plugin offers beyond its tools (P10-T07, ADR-72 item 7), as pure settings changes. */

const manifest: PluginManifest = PluginManifestSchema.parse({
  format: 1,
  id: 'office',
  name: 'Office',
  version: '0.1.0',
  author: 'Test',
  licence: 'Apache-2.0',
  summary: 'Keeps documents.',
  minApp: '1.0.0',
  instructions: 'instructions.md',
  tools: [{ name: 'note', description: 'Notes a line.', steps: [{ use: 'template', as: 'done', text: 'ok' }], returns: ['done'] }],
  mcp: [
    { id: 'wiki', name: 'Wiki', transport: 'http', url: 'https://mcp.example.com/mcp' },
    { id: 'docs', name: 'Documents', transport: 'stdio', command: 'npx', args: ['-y', '@example/docs-mcp'] },
  ],
  schedules: [{ id: 'digest', description: 'A morning digest', cron: '0 8 * * *', taskPrompt: 'Summarise yesterday.', tools: ['note', 'wiki__search', 'docs__read_file'], delivery: 'notify' }],
});

const on = (settings: Settings, ...ids: string[]): Settings => ({
  ...settings,
  characters: Object.fromEntries(ids.map((id) => [id, { voice: null, body: null, plugins: ['office'] }])),
});

describe('pluginOffers', () => {
  it('offers nothing until the plugin is on for someone, then its servers once and its schedules per character', () => {
    expect(pluginOffers(manifest, DEFAULT_SETTINGS, [])).toEqual([]);
    const offers = pluginOffers(manifest, on(DEFAULT_SETTINGS, 'alice', 'theo'), ['alice', 'theo']);
    expect(offers.map(({ offer }) => offer.key)).toEqual(['server:wiki', 'server:docs', 'schedule:alice:digest', 'schedule:theo:digest']);
    expect(offers.every(({ answer }) => answer === null)).toBe(true);
    const asked = withOfferAnswer(DEFAULT_SETTINGS, 'office', 'server:docs', 'declined');
    expect(pluginOffers(manifest, asked, ['alice']).find(({ offer }) => offer.key === 'server:docs')?.answer).toBe('declined');
  });
});

describe('withHttpServer', () => {
  it('adds it to Settings → Tools, on, tagged, under an id of its own, and records the yes', () => {
    const next = withHttpServer(DEFAULT_SETTINGS, manifest, { id: 'wiki', name: 'Wiki', transport: 'http', url: 'https://mcp.example.com/mcp' });
    expect(next.tools.servers).toEqual([{ id: 'plugin:office:wiki', label: 'Wiki', url: 'https://mcp.example.com/mcp', transport: 'http', enabled: true, auth: 'none', plugin: 'office' }]);
    expect(next.pluginOffers).toEqual({ office: { 'server:wiki': 'added' } });
    expect(pluginServerId('office', 'wiki')).toBe('plugin:office:wiki');
  });

  it('refuses, in words, when the list is full', () => {
    const full: Settings = {
      ...DEFAULT_SETTINGS,
      tools: { ...DEFAULT_SETTINGS.tools, servers: Array.from({ length: 16 }, (_, index) => ({ id: `s${index}`, label: `S${index}`, url: 'https://x.example.com', transport: 'http' as const, enabled: true, auth: 'none' as const })) },
    };
    expect(() => withHttpServer(full, manifest, { id: 'wiki', name: 'Wiki', transport: 'http', url: 'https://mcp.example.com/mcp' })).toThrow('already has 16 servers');
  });
});

describe('presetRequest', () => {
  it('names each tool as she has it: hers with the plugin, a server by its label, a program by its companion name', () => {
    const preset = manifest.schedules[0]!;
    expect(presetRequest(manifest, preset)).toEqual({
      description: 'A morning digest',
      repeat: '0 8 * * *',
      task: 'Summarise yesterday.',
      tools: ['office__note', 'wiki__search', 'office_docs__read_file'],
      delivery: 'notify',
      catchUp: 'skip',
    });
  });

  it("names the app's own tools as they are: her plans and the companion's Files (ADR-73)", () => {
    const preset = { ...manifest.schedules[0]!, tools: ['plan_list', 'files__write_document'] };
    expect(presetRequest(manifest, preset).tools).toEqual(['plan_list', 'files__write_document']);
  });

  it('makes a reminder, with no tools, of a preset with no task', () => {
    const reminder = { ...manifest.schedules[0]!, taskPrompt: '  ', tools: [] };
    expect(presetRequest(manifest, reminder)).toEqual({ description: 'A morning digest', repeat: '0 8 * * *', delivery: 'notify', catchUp: 'skip' });
  });
});

describe('removing a plugin takes back what it added', () => {
  it('finds its schedules and programs, and leaves settings as they were before it', () => {
    const mine = { id: 'mine', label: 'Mine', url: 'https://mine.example.com/mcp', transport: 'http' as const, enabled: true, auth: 'none' as const };
    const before: Settings = { ...DEFAULT_SETTINGS, tools: { ...DEFAULT_SETTINGS.tools, servers: [mine], grants: { mine: { search: { policy: 'auto', fingerprint: 'f' } } } } };
    let after = withHttpServer(before, manifest, { id: 'wiki', name: 'Wiki', transport: 'http', url: 'https://mcp.example.com/mcp' });
    after = withOfferAnswer(after, 'office', 'server:docs', 'added');
    after = withOfferAnswer(after, 'office', 'schedule:alice:digest', 'sched-1');
    after = withOfferAnswer(after, 'office', 'schedule:theo:digest', 'declined');
    after = { ...after, tools: { ...after.tools, grants: { ...after.tools.grants, 'plugin:office:wiki': { search: { policy: 'auto', fingerprint: 'g' } }, 'companion:office-docs': { read_file: { policy: 'ask', fingerprint: null } } } } };

    expect(pluginAdditions(after, manifest, 'office')).toEqual({ schedules: [{ characterId: 'alice', scheduleId: 'sched-1' }], programs: true });
    expect(scheduleOwners(after)).toEqual(new Map([['sched-1', 'office']]));
    expect(withoutPluginOffers(after, 'office')).toEqual(before);
    // Without its manifest, any added server asks the shell, which removes only tagged entries.
    expect(pluginAdditions(withOfferAnswer(before, 'office', 'server:wiki', 'added'), null, 'office').programs).toBe(true);
    expect(pluginAdditions(withOfferAnswer(before, 'office', 'server:wiki', 'added'), manifest, 'office').programs).toBe(false);
  });
});

describe("a plugin's schedule fires (P10-T07's done-when)", () => {
  it('is made from the preset, fires daily at 8 in their zone, and runs the plugin tool it names', async () => {
    const store = new FakeMemoryStore();
    // Friday 2026-11-06 20:00 in Toronto (EST).
    let clock = Date.parse('2026-11-07T01:00:00.000Z');
    const schedules = new Schedules({ store, characterId: 'alice', timeZone: 'America/Toronto', companion: false, now: () => new Date(clock) });
    const made = await schedules.create(presetRequest(manifest, { ...manifest.schedules[0]!, tools: ['note'] }));
    if (!made.ok) throw new Error(made.reason);
    expect(made.schedule).toMatchObject({ nextRunAt: '2026-11-07T13:00:00.000Z', allowedTools: ['office__note'], runOn: 'core' });

    const ran: string[] = [];
    const note: LocalTool = {
      definition: { name: 'office__note', description: 'Notes a line.', parameters: { type: 'object', properties: {} } },
      run: async () => (ran.push('office__note'), { done: 'ok' }),
    };
    const other: LocalTool = { ...note, definition: { ...note.definition, name: 'self_write_block' }, run: async () => (ran.push('self_write_block'), {}) };
    let round = 0;
    const llm: LLMProvider = {
      id: 'scripted',
      listModels: async () => [],
      async *stream(request) {
        round += 1;
        if (round === 1) {
          expect(request.tools.map((tool) => tool.name)).toEqual(['office__note']);
          yield { type: 'tool-call', call: { id: 'c1', name: 'office__note', arguments: {}, source: 'llm', requestedAt: new Date(clock).toISOString() } };
          yield { type: 'finish', reason: 'tool-calls', usage: null };
          return;
        }
        yield { type: 'text-delta', text: 'Your digest is ready.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    };
    // Saturday 08:00:30 in Toronto.
    clock = Date.parse('2026-11-07T13:00:30.000Z');
    const scheduler = attachScheduler({ store, characterId: 'alice', execute: agentExecutor({ llm, modelId: 'm', character: { name: 'Alice' }, tools: () => [note, other] }), now: () => clock });
    await scheduler.tick();
    scheduler.detach();
    expect(ran).toEqual(['office__note']);
    const [after] = await store.listSchedules('alice');
    expect(after).toMatchObject({ status: 'active', nextRunAt: '2026-11-08T13:00:00.000Z', lastRun: { outcome: 'ok', summary: 'Your digest is ready.' } });
  });
});
