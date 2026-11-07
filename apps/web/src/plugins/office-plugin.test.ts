import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeMemoryStore, Schedules, agentExecutor, attachScheduler, type LocalTool } from '@latentpresence/core';
import { PluginManifestSchema, type LLMProvider } from '@latentpresence/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings';
import { pluginOffers, presetRequest } from './offers';

/**
 * The Office plugin's schedule presets (P10-T08's done-when, ADR-73): offered once it is on for
 * someone, made from the real `plugins/office/plugin.json`, and fired with the app's own tools —
 * her plans and the companion's Files — under their own names.
 */
const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../plugins/office/plugin.json'), 'utf8')));
const on: Settings = { ...DEFAULT_SETTINGS, characters: { alice: { voice: null, body: null, plugins: ['office'] } } };

const tool = (name: string, ran: string[]): LocalTool => ({
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  run: async () => (ran.push(name), { text: `${name} ok` }),
});

describe('the Office plugin', () => {
  it('offers its two schedules and no servers, naming her own tools as they are', () => {
    expect(pluginOffers(manifest, on, ['alice']).map(({ offer }) => offer.key)).toEqual(['schedule:alice:morning_plan', 'schedule:alice:weekly_digest']);
    const [morning, digest] = manifest.schedules;
    expect(presetRequest(manifest, morning!)).toMatchObject({ repeat: '0 8 * * 1-5', tools: ['plan_list', 'schedule_list', 'files__search_files', 'files__read_document'], delivery: 'notify', catchUp: 'run_once' });
    expect(presetRequest(manifest, digest!).tools).toEqual(['plan_list', 'schedule_list', 'files__list_allowed_directories', 'files__write_document']);
  });

  it('makes the morning plan, which fires on Monday at 8 in their zone with only its tools', async () => {
    const store = new FakeMemoryStore();
    // Friday 2026-11-06 20:00 in Toronto.
    let clock = Date.parse('2026-11-07T01:00:00.000Z');
    const schedules = new Schedules({ store, characterId: 'alice', timeZone: 'America/Toronto', companion: false, now: () => new Date(clock) });
    const made = await schedules.create(presetRequest(manifest, manifest.schedules[0]!));
    if (!made.ok) throw new Error(made.reason);
    expect(made.schedule.nextRunAt).toBe('2026-11-09T13:00:00.000Z');

    const ran: string[] = [];
    const tools = ['plan_list', 'schedule_list', 'files__search_files', 'files__read_document', 'files__write_document', 'self_write_block'].map((name) => tool(name, ran));
    let round = 0;
    const llm: LLMProvider = {
      id: 'scripted',
      listModels: async () => [],
      async *stream(request) {
        round += 1;
        if (round === 1) {
          expect(request.tools.map((offered) => offered.name)).toEqual(['plan_list', 'schedule_list', 'files__search_files', 'files__read_document']);
          yield { type: 'tool-call', call: { id: 'c1', name: 'plan_list', arguments: {}, source: 'llm', requestedAt: new Date(clock).toISOString() } };
          yield { type: 'tool-call', call: { id: 'c2', name: 'files__read_document', arguments: { path: 'Plan.docx' }, source: 'llm', requestedAt: new Date(clock).toISOString() } };
          yield { type: 'finish', reason: 'tool-calls', usage: null };
          return;
        }
        yield { type: 'text-delta', text: 'Today is the dentist at ten; start with the invoice.' };
        yield { type: 'finish', reason: 'stop', usage: null };
      },
    };
    // Monday 08:00:30 in Toronto.
    clock = Date.parse('2026-11-09T13:00:30.000Z');
    const scheduler = attachScheduler({ store, characterId: 'alice', execute: agentExecutor({ llm, modelId: 'm', character: { name: 'Alice' }, tools: () => tools }), now: () => clock });
    await scheduler.tick();
    scheduler.detach();
    expect(ran).toEqual(['plan_list', 'files__read_document']);
    const [after] = await store.listSchedules('alice');
    expect(after).toMatchObject({ nextRunAt: '2026-11-10T13:00:00.000Z', lastRun: { outcome: 'ok', summary: 'Today is the dentist at ten; start with the invoice.' } });
  });
});
