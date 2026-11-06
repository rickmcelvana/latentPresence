import type { JsonValue, MemoryStore, PluginBoard, PluginParameter, PluginStep, PluginTool } from '@latentpresence/protocol';
import type { LocalTool } from '../self/tools';
import type { CheckedPlugin, PluginRow } from './check';

/**
 * A plugin's tools, run (ADR-72 item 3, P10-T02).
 *
 * Each manifest tool becomes a `LocalTool` named `<plugin>__<tool>` that runs its steps in order
 * over a scope of `args`, `settings` and the steps before it. Nothing here reaches outside the
 * plugin: the data is its own tables, the state its own system block, and a `show` hands a
 * layout to the host to draw. That is why a plugin's tools default to `auto` (ADR-72 item 3).
 *
 * A problem while running (an argument the model got wrong, a key that is not in a table) is
 * a result with an `error` sentence the model can act on, never a throw: she has to say
 * something about it either way.
 */

/** A plugin's own data for one character: one system block, JSON, hidden from her notes and prompt (ADR-72 item 5). */
export function pluginBlockName(pluginId: string): string {
  return `_plugin:${pluginId}`;
}

/** The companion creates a system block with room for this many characters (`SYSTEM_BLOCK_CHAR_LIMIT`). */
export const PLUGIN_STATE_CHAR_LIMIT = 16_000;

/** A layout for a board, resolved: what the host draws (ADR-72 item 6, P10-T05). */
export interface PluginDisplay {
  readonly pluginId: string;
  readonly board: string;
  readonly layout: PluginBoard['layout'];
  readonly where: PluginBoard['where'];
  readonly title: string | null;
  readonly items: readonly PluginDisplayItem[];
}

export interface PluginDisplayItem {
  readonly caption: string;
  /** The asset id of its image, for `cards`; null for `list`. */
  readonly image: string | null;
  /** Rotated 180°, still face up: a reversed card. */
  readonly flip: boolean;
}

export interface PluginHost {
  readonly store: MemoryStore;
  readonly characterId: string;
  /** Uniform in [0, 1). `cryptoRandom` in the app; a seeded one in tests. */
  readonly random: () => number;
  /** A `show` step's layout, to draw on the wall. */
  readonly show: (display: PluginDisplay) => void;
  /** The person's choices in Settings → Plugins; anything missing or of the wrong type is the manifest's default. */
  readonly settings?: Readonly<Record<string, JsonValue>>;
  readonly now?: () => Date;
}

/** A plugin tool, with what the gate needs to know about it. */
export interface PluginLocalTool extends LocalTool {
  readonly pluginId: string;
  readonly policy: PluginTool['policy'];
}

/** Randomness from the platform's CSPRNG: the model never picks the "random" card (ADR-72 item 3). */
export function cryptoRandom(): number {
  const crypto = (globalThis as { crypto?: { getRandomValues(array: Uint32Array): Uint32Array } }).crypto;
  if (crypto === undefined) throw new Error('This platform has no crypto.getRandomValues.');
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

export function pluginTools(plugin: CheckedPlugin, host: PluginHost): PluginLocalTool[] {
  return plugin.manifest.tools.map((tool) => ({
    pluginId: plugin.manifest.id,
    policy: tool.policy,
    definition: { name: `${plugin.manifest.id}__${tool.name}`, description: tool.description, parameters: parametersSchema(tool, plugin.data) },
    run: (args) => runTool(plugin, tool, args, host),
  }));
}

/** A step went wrong in a way the model should hear about. */
class StepProblem extends Error {}

async function runTool(plugin: CheckedPlugin, tool: PluginTool, given: Readonly<Record<string, JsonValue>>, host: PluginHost): Promise<JsonValue> {
  const args = readArguments(tool, given, plugin.data);
  if ('error' in args) return args;
  const scope: Record<string, JsonValue> = { args: args.values, settings: settingsOf(plugin, host.settings) };
  try {
    for (const step of tool.steps) {
      const value = await runStep(step, scope, plugin, host);
      if ('as' in step && step.as !== undefined) scope[step.as] = value;
    }
  } catch (error) {
    if (error instanceof StepProblem) return { error: error.message };
    throw error;
  }
  return Object.fromEntries(tool.returns.map((name) => [name, scope[name] ?? null]));
}

async function runStep(step: PluginStep, scope: Readonly<Record<string, JsonValue>>, plugin: CheckedPlugin, host: PluginHost): Promise<JsonValue> {
  switch (step.use) {
    case 'draw': {
      const rows = plugin.data[step.table] ?? [];
      const slots = step.slots === undefined ? undefined : resolve(step.slots, scope);
      if (slots !== undefined && (!Array.isArray(slots) || slots.length === 0)) throw new StepProblem(`The slots for drawing from ${step.table} are not a list.`);
      const count = step.count === undefined ? (slots?.length ?? 1) : resolve(step.count, scope);
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > rows.length) {
        throw new StepProblem(`Cannot draw ${JSON.stringify(count)} from ${step.table}: it holds ${rows.length}, and a draw takes 1 to ${rows.length}.`);
      }
      const chance = reversedChance(resolve(step.reversed, scope));
      return drawIndices(rows.length, count, host.random).map((index, position) => ({
        ...rows[index],
        reversed: chance > 0 && host.random() < chance,
        slot: slots === undefined ? position + 1 : text(slots[position] ?? position + 1),
      }));
    }
    case 'roll': {
      const notation = resolve(step.dice, scope);
      const dice = typeof notation === 'string' ? /^(\d{0,2})d(\d{1,3})([+-]\d{1,3})?$/.exec(notation) : null;
      const count = dice === null ? 0 : dice[1] === '' ? 1 : Number(dice[1]);
      const sides = dice === null ? 0 : Number(dice[2]);
      if (dice === null || count < 1 || sides < 1) throw new StepProblem(`${JSON.stringify(notation)} is not dice to roll; write it like d20, 3d6 or 2d10+1.`);
      const rolls = Array.from({ length: count }, () => Math.floor(host.random() * sides) + 1);
      return { total: rolls.reduce((sum, roll) => sum + roll, 0) + Number(dice[3] ?? 0), rolls };
    }
    case 'lookup': {
      const rows = plugin.data[step.table] ?? [];
      const key = resolve(step.key, scope);
      const row = rows.find((candidate) => candidate[step.by] === key) ?? rows.find((candidate) => text(candidate[step.by] ?? null) === text(key));
      if (row === undefined) {
        const choices = rows.slice(0, 20).map((candidate) => text(candidate[step.by] ?? null));
        throw new StepProblem(`There is no "${text(key)}" in ${step.table}. The choices are: ${choices.join(', ')}${rows.length > 20 ? ', …' : ''}.`);
      }
      return row;
    }
    case 'template':
      return fill(step.text, scope);
    case 'state':
      return state(step, scope, plugin.manifest.id, host);
    case 'show': {
      const board = plugin.manifest.boards[step.board];
      if (board === undefined) throw new StepProblem(`The plugin has no board "${step.board}".`); // checkPlugin refuses this; kept for a hand-built plugin
      const value = resolve(step.items, scope);
      const rows = (Array.isArray(value) ? value : [value]).filter(isRow);
      host.show({
        pluginId: plugin.manifest.id,
        board: step.board,
        layout: board.layout,
        where: board.where,
        title: step.title === undefined ? null : text(resolve(step.title, scope)),
        items: rows.map((row) =>
          board.layout === 'cards'
            ? { caption: fill(board.caption, row), image: typeof row[board.image] === 'string' ? (row[board.image] as string) : null, flip: board.flip !== undefined && row[board.flip] === true }
            : { caption: fill(board.line, row), image: null, flip: false },
        ),
      });
      return null;
    }
  }
}

/**
 * `count` distinct indices below `size`, uniformly: the first `count` places of a Fisher–Yates
 * shuffle. Every ordered selection is equally likely, so every slot is uniform too.
 */
export function drawIndices(size: number, count: number, random: () => number): number[] {
  const deck = Array.from({ length: size }, (_, index) => index);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.min(Math.floor(random() * (size - i)), size - i - 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck.slice(0, count);
}

function reversedChance(value: JsonValue | undefined): number {
  if (value === true) return 0.5; // a shuffled deck with cards either way up (ADR-72's build notes)
  if (typeof value === 'number' && value >= 0 && value <= 1) return value;
  return 0;
}

async function state(step: Extract<PluginStep, { use: 'state' }>, scope: Readonly<Record<string, JsonValue>>, pluginId: string, host: PluginHost): Promise<JsonValue> {
  const name = pluginBlockName(pluginId);
  const block = (await host.store.readBlocks(host.characterId)).find((candidate) => candidate.name === name);
  let data: Record<string, JsonValue> = {};
  if (block !== undefined && block.content !== '') {
    try {
      const parsed: unknown = JSON.parse(block.content);
      if (isRow(parsed)) data = { ...parsed };
    } catch {
      // A block that is not JSON was not written here; start again rather than fail every call.
    }
  }
  if (step.op === 'get') return data[step.key] ?? null;
  if (step.op === 'clear') delete data[step.key];
  else {
    const value = resolve(step.value ?? null, scope);
    if (step.op === 'set') data[step.key] = value;
    else {
      const existing = data[step.key];
      if (existing !== undefined && existing !== null && !Array.isArray(existing)) throw new StepProblem(`"${step.key}" holds one value, not a list, so nothing can be added to it.`);
      data[step.key] = [...(existing ?? []), value];
    }
  }
  const content = JSON.stringify(data);
  if (content.length > PLUGIN_STATE_CHAR_LIMIT) throw new StepProblem(`The plugin's memory for this character is full (${PLUGIN_STATE_CHAR_LIMIT} characters); nothing was saved.`);
  await host.store.writeBlock({ characterId: host.characterId, name, content, updatedAt: (host.now?.() ?? new Date()).toISOString(), editableByCharacter: false });
  return step.op === 'set' || step.op === 'append' ? (data[step.key] ?? null) : null;
}

// ── Arguments and settings ────────────────────────────────────────────────────

function parametersSchema(tool: PluginTool, data: CheckedPlugin['data']): Record<string, JsonValue> {
  const properties: Record<string, JsonValue> = {};
  for (const [name, parameter] of Object.entries(tool.parameters)) {
    const choices = choicesOf(parameter, data);
    properties[name] = {
      type: parameter.type,
      description: parameter.description,
      ...(choices === null ? {} : { enum: choices }),
      ...(parameter.minimum === undefined ? {} : { minimum: parameter.minimum }),
      ...(parameter.maximum === undefined ? {} : { maximum: parameter.maximum }),
      ...(parameter.default === undefined ? {} : { default: parameter.default }),
    };
  }
  const required = Object.entries(tool.parameters).filter(([, parameter]) => parameter.required).map(([name]) => name);
  return { type: 'object', properties, required };
}

function choicesOf(parameter: PluginParameter, data: CheckedPlugin['data']): string[] | null {
  if (parameter.enum !== undefined) return [...parameter.enum];
  if (parameter.enumFrom === undefined) return null;
  const { table, column } = parameter.enumFrom;
  return [...new Set((data[table] ?? []).map((row) => text(row[column] ?? null)))];
}

/**
 * The model's arguments, held to the parameters. Small models send `"3"` for 3 and `"true"` for
 * true often enough that a plain number or boolean in a string is taken as one; anything else
 * wrong is said back in a sentence.
 */
function readArguments(tool: PluginTool, given: Readonly<Record<string, JsonValue>>, data: CheckedPlugin['data']): { readonly values: Record<string, JsonValue> } | { readonly error: string } {
  const values: Record<string, JsonValue> = {};
  for (const [name, parameter] of Object.entries(tool.parameters)) {
    let value = given[name];
    if (value === undefined || value === null || value === '') {
      if (parameter.default !== undefined) values[name] = parameter.default;
      else if (parameter.required) return { error: `${tool.name} needs "${name}": ${parameter.description}` };
      continue;
    }
    if ((parameter.type === 'number' || parameter.type === 'integer') && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
    if (parameter.type === 'boolean' && (value === 'true' || value === 'false')) value = value === 'true';
    const fits = parameter.type === 'integer' ? Number.isInteger(value) : typeof value === parameter.type;
    if (!fits) return { error: `"${name}" must be ${parameter.type === 'integer' ? 'a whole number' : `a ${parameter.type}`}, not ${JSON.stringify(value)}.` };
    if (typeof value === 'number') {
      if (parameter.minimum !== undefined && value < parameter.minimum) return { error: `"${name}" must be at least ${parameter.minimum}.` };
      if (parameter.maximum !== undefined && value > parameter.maximum) return { error: `"${name}" must be at most ${parameter.maximum}.` };
    }
    const choices = choicesOf(parameter, data);
    if (choices !== null && !choices.includes(text(value))) return { error: `"${name}" must be one of: ${choices.join(', ')}. ${JSON.stringify(value)} is not.` };
    values[name] = value;
  }
  return { values };
}

function settingsOf(plugin: CheckedPlugin, chosen: Readonly<Record<string, JsonValue>> | undefined): Record<string, JsonValue> {
  const settings: Record<string, JsonValue> = {};
  for (const [key, setting] of Object.entries(plugin.manifest.settings)) {
    const value = chosen?.[key];
    const fits =
      setting.type === 'switch' ? typeof value === 'boolean'
      : setting.type === 'number' ? typeof value === 'number' && (setting.minimum === undefined || value >= setting.minimum) && (setting.maximum === undefined || value <= setting.maximum)
      : setting.type === 'choice' ? typeof value === 'string' && setting.choices.includes(value)
      : typeof value === 'string';
    settings[key] = fits ? (value as JsonValue) : setting.default;
  }
  return settings;
}

// ── References and templates ──────────────────────────────────────────────────

/** A step value: `$path` read from the scope, a string filled as a template, arrays and objects walked. */
function resolve(value: JsonValue, scope: Readonly<Record<string, JsonValue>>): JsonValue {
  if (typeof value === 'string') return value.startsWith('$') ? (read(value.slice(1), scope) ?? null) : fill(value, scope);
  if (Array.isArray(value)) return value.map((item) => resolve(item, scope));
  if (isRow(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, scope)]));
  return value;
}

function read(path: string, scope: Readonly<Record<string, JsonValue>>): JsonValue | undefined {
  let current: JsonValue | undefined = scope;
  for (const part of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (isRow(current)) current = current[part];
    else return undefined;
  }
  return current;
}

/** `{{path}}` replaced by what it names; nothing for what names nothing. */
export function fill(template: string, scope: Readonly<Record<string, JsonValue>>): string {
  return template.replaceAll(/\{\{\s*([a-z][a-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g, (_whole, path: string) => text(read(path, scope) ?? null));
}

function text(value: JsonValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isRow(value: unknown): value is PluginRow & Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
