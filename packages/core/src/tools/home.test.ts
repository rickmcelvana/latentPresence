import type { JsonObject, McpCallResult, McpServerClient, McpToolInfo } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { settle } from '../testing/scripted';
import { ManualTimers } from '../testing/timers';
import { HA_ASSIST_PROMPT } from './fixtures/ha-assist-prompt';
import { PermissionPrompts, type ToolGrant, type ToolGrants } from './gate';
import { areaDevices, deviceKey, findDevice, homeTarget, homeVerdict, isReadingTool, mayBeAuto, parseHomeOverview, type HomeDevice } from './home';
import { mcpTools, type ConnectedToolServer } from './mcp';

const DEVICES = parseHomeOverview(HA_ASSIST_PROMPT);
const device = (name: string): HomeDevice => {
  const found = findDevice(DEVICES, name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

describe("parseHomeOverview: HA 2026.9.4's own Assist prompt (P5-T07, ADR-48)", () => {
  it('reads every device, with its domain and area, and an alias in place of the name', () => {
    expect(DEVICES).toHaveLength(45);
    expect(device('Kitchen Lights')).toEqual({ names: ['Kitchen Lights'], domain: 'light', areas: ['Kitchen'] });
    expect(device('Garage Door')).toEqual({ names: ['Garage Door'], domain: 'cover', areas: ['Garage'] });
    expect(device('AC')).toEqual({ names: ['AC'], domain: 'switch', areas: [] });
    // HA lists the alias instead of the name once one is set.
    expect(device('big light')).toEqual({ names: ['big light'], domain: 'light', areas: [] });
    expect(device('KITCHEN LIGHTS')).toBe(device('Kitchen Lights'));
  });

  it('reads quoted, folded and several names, and nothing from text without an overview', () => {
    const text = [
      'Static Context: An overview of the areas and the devices in this smart home:',
      "- names: 'Lamp: desk, Reading lamp'",
      '  domain: light',
      '  areas: Study, Den',
      '- names: A very long device name that PyYAML folds onto the',
      '    next line',
      '  domain: switch',
      '',
      'When controlling Home Assistant always call the intent tools.',
    ].join('\n');
    expect(parseHomeOverview(text)).toEqual([
      { names: ['Lamp: desk', 'Reading lamp'], domain: 'light', areas: ['Study', 'Den'] },
      { names: ['A very long device name that PyYAML folds onto the next line'], domain: 'switch', areas: [] },
    ]);
    expect(parseHomeOverview('You ARE equipped to answer questions.')).toEqual([]);
  });
});

const none = (): ToolGrant | undefined => undefined;
const granted = (entries: Record<string, ToolGrant['policy']>) => (key: string): ToolGrant | undefined =>
  entries[key] === undefined ? undefined : { policy: entries[key], fingerprint: null };

describe('homeVerdict', () => {

  it('leaves reading tools to the per-tool gate', () => {
    for (const tool of ['homeassistant__GetLiveContext', 'llm__GetDateTime', 'todo__get_items']) {
      expect(isReadingTool(tool)).toBe(true);
      expect(homeVerdict(tool, {}, DEVICES, none)).toEqual({ kind: 'tool' });
    }
    expect(isReadingTool('intent__HassTurnOn')).toBe(false);
  });

  it('asks about a named device by default, and offers "always" for that device', () => {
    expect(homeVerdict('intent__HassTurnOn', { name: 'kitchen lights', domain: ['light'] }, DEVICES, none)).toEqual({ kind: 'ask', target: 'Kitchen Lights (Kitchen)', device: device('Kitchen Lights') });
  });

  it("follows the device's own grant: auto runs, never refuses", () => {
    const set = granted({ [deviceKey(device('Kitchen Lights'))]: 'auto', [deviceKey(device('Bed Light'))]: 'never' });
    expect(homeVerdict('intent__HassTurnOff', { name: 'Kitchen Lights' }, DEVICES, set)).toEqual({ kind: 'auto', target: 'Kitchen Lights (Kitchen)' });
    expect(homeVerdict('light__HassLightSet', { name: 'Bed Light', brightness: 20 }, DEVICES, set)).toEqual({ kind: 'never', target: 'Bed Light (Bedroom)' });
    // An auto light does not make another light auto.
    expect(homeVerdict('intent__HassTurnOff', { name: 'Office RGBW Lights' }, DEVICES, set).kind).toBe('ask');
  });

  it('always asks a call that names no device and no room: it reaches every device that matches', () => {
    const set = granted({ [deviceKey(device('Kitchen Lights'))]: 'auto' });
    expect(homeVerdict('intent__HassTurnOff', { domain: ['light'] }, DEVICES, set)).toEqual({ kind: 'ask', target: 'every light that matches, anywhere in the home', device: null });
    expect(homeVerdict('intent__HassTurnOn', { floor: 'Upstairs', domain: ['light'] }, DEVICES, set)).toEqual({ kind: 'ask', target: 'every light in Upstairs', device: null });
    // A room with no domain could be anything in it, the window included.
    expect(homeVerdict('intent__HassTurnOff', { area: 'Kitchen' }, DEVICES, set)).toEqual({ kind: 'ask', target: 'every device in Kitchen', device: null });
  });

  it("treats a room's one light, asked for by area and domain, as that light (P5-T07 live run)", () => {
    // glm, told they were in the kitchen, sent { area, domain } for "turn on the light" 3/3, as HA's prompt advises.
    const call = { area: 'kitchen', domain: ['light'] };
    expect(homeVerdict('intent__HassTurnOn', call, DEVICES, none)).toEqual({ kind: 'ask', target: 'Kitchen Lights (Kitchen)', device: device('Kitchen Lights') });
    expect(homeVerdict('intent__HassTurnOn', call, DEVICES, granted({ [deviceKey(device('Kitchen Lights'))]: 'auto' }))).toEqual({ kind: 'auto', target: 'Kitchen Lights (Kitchen)' });
    expect(homeVerdict('intent__HassTurnOn', call, DEVICES, granted({ [deviceKey(device('Kitchen Lights'))]: 'never' })).kind).toBe('never');
    expect(areaDevices(call, DEVICES)).toEqual([device('Kitchen Lights')]);
  });

  it('runs a room of several devices by itself only when every one is auto, and never works out a door', () => {
    const fan = device('Living Room Fan');
    const lights = device('Living Room RGBWW Lights');
    const call = { area: 'Living Room', domain: ['light', 'fan'] };
    expect(homeVerdict('intent__HassTurnOff', call, DEVICES, granted({ [deviceKey(lights)]: 'auto' }))).toEqual({ kind: 'ask', target: 'every light and fan in Living Room: Living Room Fan, Living Room RGBWW Lights', device: null });
    expect(homeVerdict('intent__HassTurnOff', call, DEVICES, granted({ [deviceKey(lights)]: 'auto', [deviceKey(fan)]: 'auto' })).kind).toBe('auto');
    const garage = device('Garage Door');
    expect(homeVerdict('intent__HassTurnOn', { area: 'Garage', domain: ['cover'] }, DEVICES, granted({ [deviceKey(garage)]: 'auto' }))).toEqual({ kind: 'ask', target: 'every cover in Garage', device: null });
  });

  it('asks about a name HA did not list, and offers no "always" for it', () => {
    expect(homeVerdict('intent__HassTurnOn', { name: 'Porch lamp' }, DEVICES, none)).toEqual({ kind: 'ask', target: 'Porch lamp (not in Home Assistant\'s list)', device: null });
  });

  it('never lets a lock, alarm, cover or valve run by itself, whatever its grant says', () => {
    const garage = device('Garage Door');
    expect(mayBeAuto(garage)).toBe(false);
    expect(mayBeAuto(device('Kitchen Lights'))).toBe(true);
    // A grant written by hand (or by an older page) still does not open the garage.
    expect(homeVerdict('intent__HassTurnOn', { name: 'Garage Door' }, DEVICES, granted({ [deviceKey(garage)]: 'auto' }))).toEqual({ kind: 'ask', target: 'Garage Door (Garage)', device: null });
    expect(homeVerdict('intent__HassTurnOn', { name: 'Garage Door' }, DEVICES, granted({ [deviceKey(garage)]: 'never' })).kind).toBe('never');
    const lock: HomeDevice = { names: ['Front Door'], domain: 'lock', areas: ['Hallway'] };
    expect(homeVerdict('intent__HassTurnOff', { name: 'Front Door' }, [lock], granted({ [deviceKey(lock)]: 'auto' })).kind).toBe('ask');
  });

  it('says what a call reaches in words', () => {
    expect(homeTarget({ name: 'AC' }, device('AC'))).toBe('AC');
    expect(homeTarget({ domain: ['light', 'switch'], area: 'Den' }, undefined)).toBe('every light and switch in Den');
  });
});

const TURN_ON: McpToolInfo = { name: 'intent__HassTurnOn', description: 'Turns on/opens/presses a device or entity.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } }, annotations: null };
const LIVE: McpToolInfo = { name: 'homeassistant__GetLiveContext', description: 'Provides real-time information.', inputSchema: { type: 'object' }, annotations: null };

class Home implements McpServerClient {
  readonly serverName = 'home-assistant';
  readonly instructions = null;
  readonly calls: { name: string; args: JsonObject }[] = [];
  async listTools(): Promise<McpToolInfo[]> {
    return [TURN_ON, LIVE];
  }
  async callTool(name: string, args: JsonObject): Promise<McpCallResult> {
    this.calls.push({ name, args });
    return { isError: false, text: '{"response_type": "action_done"}', structured: null, images: 0 };
  }
  async close(): Promise<void> {}
}

class Grants implements ToolGrants {
  readonly map = new Map<string, ToolGrant>();
  get(serverId: string, tool: string): ToolGrant | undefined {
    return this.map.get(`${serverId}/${tool}`);
  }
  set(serverId: string, tool: string, grant: ToolGrant): void {
    this.map.set(`${serverId}/${tool}`, grant);
  }
}

describe('mcpTools with Home Assistant', () => {
  function setup() {
    const client = new Home();
    const grants = new Grants();
    const server: ConnectedToolServer = { id: 'companion:homeassistant', label: 'Home Assistant', client, tools: [TURN_ON, LIVE], home: { devices: DEVICES } };
    const prompts = new PermissionPrompts({ timers: new ManualTimers() });
    const tools = mcpTools([server], { grants, prompts });
    const run = (tool: string, args: JsonObject) => {
      const found = tools.find((candidate) => candidate.definition.name === `home_assistant__${tool}`);
      if (found === undefined) throw new Error(`no ${tool}`);
      return found.run(args, { call: { id: 'c1', name: tool, arguments: args, source: 'llm', requestedAt: '2026-10-11T12:00:00.000Z' } });
    };
    return { client, grants, prompts, run };
  }

  it('asks with the device in words, and "always" trusts that device, not the tool', async () => {
    const { client, grants, prompts, run } = setup();
    const first = run('intent__HassTurnOn', { name: 'Kitchen Lights', domain: ['light'] });
    await settle();
    expect(prompts.snapshot()).toEqual([expect.objectContaining({ tool: 'intent__HassTurnOn', target: 'Kitchen Lights (Kitchen)', always: 'Kitchen Lights' })]);
    prompts.answer(prompts.snapshot()[0]!.id, 'always');
    await first;
    expect(grants.get('companion:homeassistant', 'device:kitchen lights')).toEqual({ policy: 'auto', fingerprint: null });
    expect(grants.get('companion:homeassistant', 'intent__HassTurnOn')).toBeUndefined();

    // The same light now runs unasked; another device still asks.
    await run('intent__HassTurnOn', { name: 'Kitchen Lights' });
    expect(prompts.snapshot()).toEqual([]);
    const other = run('intent__HassTurnOn', { name: 'Bed Light' });
    await settle();
    expect(prompts.snapshot()).toHaveLength(1);
    prompts.answer(prompts.snapshot()[0]!.id, 'deny');
    expect(await other).toEqual({ error: expect.stringContaining('said no') });
    expect(client.calls.map((call) => call.args['name'])).toEqual(['Kitchen Lights', 'Kitchen Lights']);
  });

  it('offers no "always" for the garage door, and refuses a device set to never without asking', async () => {
    const { client, grants, prompts, run } = setup();
    const garage = run('intent__HassTurnOn', { name: 'Garage Door' });
    await settle();
    expect(prompts.snapshot()[0]).toEqual(expect.objectContaining({ target: 'Garage Door (Garage)', always: null }));
    prompts.answer(prompts.snapshot()[0]!.id, 'once');
    await garage;
    grants.set('companion:homeassistant', 'device:bed light', { policy: 'never', fingerprint: null });
    expect(await run('intent__HassTurnOn', { name: 'Bed Light' })).toEqual({ error: expect.stringContaining('does not let you control Bed Light (Bedroom)') });
    expect(prompts.snapshot()).toEqual([]);
    expect(client.calls.map((call) => call.args['name'])).toEqual(['Garage Door']);
  });

  it('gates a reading tool per tool, as any other', async () => {
    const { grants, prompts, run } = setup();
    const read = run('homeassistant__GetLiveContext', { domain: 'light' });
    await settle();
    expect(prompts.snapshot()[0]).toEqual(expect.objectContaining({ tool: 'homeassistant__GetLiveContext' }));
    expect(prompts.snapshot()[0]?.always).toBeUndefined();
    prompts.answer(prompts.snapshot()[0]!.id, 'always');
    await read;
    expect(grants.get('companion:homeassistant', 'homeassistant__GetLiveContext')?.policy).toBe('auto');
  });
});
