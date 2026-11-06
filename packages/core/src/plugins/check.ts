import {
  PLUGIN_FORMAT,
  PLUGIN_PRIMITIVES,
  PluginManifestSchema,
  type JsonValue,
  type PluginBoard,
  type PluginManifest,
  type PluginStep,
  type PluginTool,
} from '@latentpresence/protocol';
import { parseCron } from '../scheduler/cron';

/**
 * Whether a plugin folder is what its `plugin.json` says (ADR-72, P10-T01).
 *
 * The protocol's schema says the manifest has the right shape. This says the names in it point
 * at something: the files are there, the data is tables, the hashes match, every step reads a
 * table that exists and every reference names an argument, a setting or an earlier step. It
 * runs in `pnpm plugin:check` and, the same function, when the app installs a plugin (P10-T03),
 * so an author sees exactly what a person's app would refuse.
 *
 * Every problem is a sentence a plugin's author can act on, naming where it is. All of them are
 * collected, not just the first: fixing one at a time through a file is slow.
 */

/** A row of a data table. */
export type PluginRow = Readonly<Record<string, JsonValue>>;

/** The plugin's folder, wherever it is: a directory on disk, a zip, the browser's storage. */
export interface PluginFolder {
  /** The file's bytes, or null when the folder has no such file. */
  bytes(path: string): Promise<Uint8Array | null>;
  /** The file as UTF-8 text, or null when the folder has no such file. */
  text(path: string): Promise<string | null>;
}

export interface CheckPluginOptions {
  /** Lowercase hex. Injected: the core has no crypto of its own (the page has `crypto.subtle`, node `node:crypto`). */
  readonly sha256: (bytes: Uint8Array) => Promise<string>;
  /** The running app's version, for `minApp`. Absent, `minApp` is not compared. */
  readonly appVersion?: string;
  /** Downloads an asset's address to check its bytes. Absent, an address is checked as listed. */
  readonly fetchAsset?: (url: string) => Promise<Uint8Array>;
}

export interface CheckedPlugin {
  readonly manifest: PluginManifest;
  readonly instructions: string;
  readonly data: Readonly<Record<string, readonly PluginRow[]>>;
  /** Every asset's bytes together: what the consent screen says it may download or keep. */
  readonly assetBytes: number;
  /**
   * Rough tokens (characters / 4, ADR-72 item 4): `idle` while enabled and unused (the summary
   * line), `used` once it is used (instructions and tool definitions). An estimate, said as one.
   */
  readonly promptTokens: { readonly idle: number; readonly used: number };
}

export type PluginCheck =
  | { readonly ok: true; readonly plugin: CheckedPlugin; readonly notes: readonly string[] }
  | { readonly ok: false; readonly problems: readonly string[] };

export const PLUGIN_LIMITS = {
  instructionsChars: 16_000,
  tableRows: 5_000,
  tableChars: 2_000_000,
} as const;

/** Instructions past this are allowed, and said: they join the prompt every time the plugin is used. */
const LONG_INSTRUCTIONS_CHARS = 4_000;

/** Fields a `draw` adds to every row it draws. */
const DRAWN_FIELDS = ['reversed', 'slot'] as const;
const ROLL_FIELDS = ['total', 'rolls'] as const;

export async function checkPlugin(manifestText: string, folder: PluginFolder, options: CheckPluginOptions): Promise<PluginCheck> {
  const problems: string[] = [];
  const notes: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (error) {
    return { ok: false, problems: [`plugin.json is not JSON: ${error instanceof Error ? error.message : String(error)}.`] };
  }
  const format = isObject(raw) ? raw['format'] : undefined;
  if (format === undefined) return { ok: false, problems: [`plugin.json has no "format": this app reads format ${PLUGIN_FORMAT}, so add "format": ${PLUGIN_FORMAT}.`] };
  if (typeof format === 'number' && format > PLUGIN_FORMAT) {
    return { ok: false, problems: [`plugin.json is format ${format}, newer than this app reads (format ${PLUGIN_FORMAT}): it needs a newer latentPresence.`] };
  }
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `plugin.json, ${where(issue.path)}: ${issueMessage(issue)}.`) };
  }
  const manifest = parsed.data;

  if (options.appVersion !== undefined && compareVersions(manifest.minApp, options.appVersion) > 0) {
    problems.push(`It needs latentPresence ${manifest.minApp} or newer, and this is ${options.appVersion}.`);
  }

  // ── Files ──
  const instructions = await folder.text(manifest.instructions);
  if (instructions === null) problems.push(`The instructions file "${manifest.instructions}" is not in the folder.`);
  else if (instructions.trim() === '') problems.push(`The instructions file "${manifest.instructions}" is empty.`);
  else if (instructions.length > PLUGIN_LIMITS.instructionsChars) {
    problems.push(`The instructions file "${manifest.instructions}" is ${instructions.length} characters; the most is ${PLUGIN_LIMITS.instructionsChars}, since it joins the prompt.`);
  } else if (instructions.length > LONG_INSTRUCTIONS_CHARS) {
    notes.push(`The instructions are ${instructions.length} characters (about ${tokens(instructions)} tokens), added to the prompt whenever the plugin is used.`);
  }

  const data: Record<string, PluginRow[]> = {};
  for (const [name, path] of Object.entries(manifest.data)) {
    const rows = await readTable(name, path, folder, problems);
    if (rows !== null) data[name] = rows;
  }

  let assetBytes = 0;
  const assetIds = new Set<string>();
  for (const [index, asset] of manifest.assets.entries()) {
    const label = `Asset "${asset.id}"`;
    if (assetIds.has(asset.id)) problems.push(`${label} is listed twice (assets[${index}]).`);
    assetIds.add(asset.id);
    assetBytes += asset.bytes;
    let bytes: Uint8Array | null = null;
    if (asset.path !== undefined) {
      bytes = await folder.bytes(asset.path);
      if (bytes === null) {
        problems.push(`${label}: "${asset.path}" is not in the folder.`);
        continue;
      }
    } else if (asset.url !== undefined && options.fetchAsset !== undefined) {
      try {
        bytes = await options.fetchAsset(asset.url);
      } catch (error) {
        problems.push(`${label}: ${asset.url} could not be downloaded (${error instanceof Error ? error.message : String(error)}).`);
        continue;
      }
    }
    if (bytes === null) continue;
    const from = asset.path ?? asset.url ?? '';
    if (bytes.length !== asset.bytes) problems.push(`${label}: ${from} is ${bytes.length} bytes, and the manifest says ${asset.bytes}.`);
    const hash = await options.sha256(bytes);
    if (hash !== asset.sha256) problems.push(`${label}: ${from} has SHA-256 ${hash}, and the manifest says ${asset.sha256}.`);
    const sniffed = sniffImage(bytes);
    if (sniffed !== null && sniffed !== asset.type) problems.push(`${label}: ${from} is ${sniffed}, and the manifest says ${asset.type}.`);
  }

  // ── Names that must be unique ──
  duplicates(manifest.tools.map((tool) => tool.name), (name) => problems.push(`Two tools are named "${name}".`));
  duplicates(manifest.mcp.map((server) => server.id), (id) => problems.push(`Two MCP servers have the id "${id}".`));
  duplicates(manifest.schedules.map((schedule) => schedule.id), (id) => problems.push(`Two schedules have the id "${id}".`));

  // ── Settings ──
  for (const [key, setting] of Object.entries(manifest.settings)) {
    if (setting.type === 'choice' && !setting.choices.includes(setting.default)) problems.push(`Setting "${key}": its default "${setting.default}" is not one of its choices.`);
    if (setting.type === 'number') {
      if (setting.minimum !== undefined && setting.default < setting.minimum) problems.push(`Setting "${key}": its default ${setting.default} is below its minimum ${setting.minimum}.`);
      if (setting.maximum !== undefined && setting.default > setting.maximum) problems.push(`Setting "${key}": its default ${setting.default} is above its maximum ${setting.maximum}.`);
    }
  }

  // ── Tools ──
  const context: ToolContext = { manifest, data, assetIds, problems };
  for (const tool of manifest.tools) checkTool(tool, context);

  // ── Schedules ──
  const toolNames = new Set(manifest.tools.map((tool) => tool.name));
  const mcpIds = new Set(manifest.mcp.map((server) => server.id));
  for (const schedule of manifest.schedules) {
    const label = `Schedule "${schedule.id}"`;
    try {
      parseCron(schedule.cron, 'UTC');
    } catch (error) {
      problems.push(`${label}: "${schedule.cron}" is not a cron expression this app reads (${error instanceof Error ? error.message : String(error)}).`);
    }
    for (const name of schedule.tools) {
      const server = name.includes('__') ? name.slice(0, name.indexOf('__')) : null;
      if (server === null ? !toolNames.has(name) : !mcpIds.has(server)) {
        problems.push(`${label}: "${name}" is neither one of the plugin's tools nor "<server>__<tool>" for one of its MCP servers.`);
      }
    }
  }

  // ── Notes ──
  const shown = new Set(manifest.tools.flatMap((tool) => tool.steps.flatMap((step) => (step.use === 'show' ? [step.board] : []))));
  for (const board of Object.keys(manifest.boards)) if (!shown.has(board)) notes.push(`Board "${board}" is never shown by a tool.`);
  const read = new Set(manifest.tools.flatMap((tool) => [
    ...tool.steps.flatMap((step) => (step.use === 'draw' || step.use === 'lookup' ? [step.table] : [])),
    ...Object.values(tool.parameters).flatMap((parameter) => (parameter.enumFrom === undefined ? [] : [parameter.enumFrom.table])),
  ]));
  for (const table of Object.keys(manifest.data)) if (!read.has(table)) notes.push(`Table "${table}" is never read by a tool.`);

  if (problems.length > 0) return { ok: false, problems };
  const used = (instructions ?? '') + JSON.stringify(manifest.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
  return {
    ok: true,
    plugin: { manifest, instructions: instructions ?? '', data, assetBytes, promptTokens: { idle: tokens(manifest.summary), used: tokens(used) } },
    notes,
  };
}

// ── Tools, steps and references ───────────────────────────────────────────────

interface ToolContext {
  readonly manifest: PluginManifest;
  readonly data: Readonly<Record<string, readonly PluginRow[]>>;
  readonly assetIds: ReadonlySet<string>;
  readonly problems: string[];
}

/** What an earlier step produced, as far as a later reference can be checked against it. */
type Produced =
  | { readonly kind: 'rows'; readonly table: string } // draw
  | { readonly kind: 'row'; readonly table: string } // lookup
  | { readonly kind: 'roll' }
  | { readonly kind: 'value' }; // template, state

function checkTool(tool: PluginTool, context: ToolContext): void {
  const { problems } = context;
  const label = `Tool "${tool.name}"`;

  for (const [name, parameter] of Object.entries(tool.parameters)) {
    const at = `${label}, parameter "${name}"`;
    if ((parameter.enum !== undefined || parameter.enumFrom !== undefined) && parameter.type !== 'string') problems.push(`${at}: only a string can have an "enum" or "enumFrom".`);
    if (parameter.enum !== undefined && parameter.enumFrom !== undefined) problems.push(`${at}: has both "enum" and "enumFrom"; keep one.`);
    if ((parameter.minimum !== undefined || parameter.maximum !== undefined) && parameter.type !== 'number' && parameter.type !== 'integer') problems.push(`${at}: only a number can have a "minimum" or "maximum".`);
    if (parameter.default !== undefined && !defaultFits(parameter.type, parameter.default)) problems.push(`${at}: its default ${JSON.stringify(parameter.default)} is not a ${parameter.type}.`);
    if (parameter.enumFrom !== undefined) {
      const rows = tableFor(parameter.enumFrom.table, at, context);
      if (rows !== null) requireColumn(rows, parameter.enumFrom.table, parameter.enumFrom.column, at, problems);
    }
  }

  const produced = new Map<string, Produced>();
  for (const [index, step] of tool.steps.entries()) {
    const at = `${label}, step ${index + 1} (${step.use})`;
    const refs = (value: unknown, field: string) => checkValue(value, `${at}, "${field}"`, tool, produced, context);

    switch (step.use) {
      case 'draw': {
        const rows = tableFor(step.table, at, context);
        refs(step.count, 'count');
        refs(step.slots, 'slots');
        refs(step.reversed, 'reversed');
        if (rows !== null) {
          const count = typeof step.count === 'number' ? step.count : Array.isArray(step.slots) ? step.slots.length : 1;
          if (typeof step.count === 'number' && Array.isArray(step.slots) && step.count !== step.slots.length) {
            problems.push(`${at}: draws ${step.count} but names ${step.slots.length} slots.`);
          } else if (count > rows.length) {
            problems.push(`${at}: draws ${count} from "${step.table}", which has ${rows.length} rows.`);
          }
        }
        break;
      }
      case 'lookup': {
        const rows = tableFor(step.table, at, context);
        if (rows !== null) requireColumn(rows, step.table, step.by, at, problems);
        refs(step.key, 'key');
        break;
      }
      case 'roll':
        refs(step.dice, 'dice');
        break;
      case 'template':
        refs(step.text, 'text');
        break;
      case 'state':
        refs(step.value, 'value');
        break;
      case 'show':
        checkShow(step, at, tool, produced, context);
        break;
    }

    const name = 'as' in step ? step.as : undefined;
    if (name !== undefined) {
      if (name === 'args' || name === 'settings') problems.push(`${at}: "${name}" is taken by $${name}; name the step something else.`);
      else if (produced.has(name)) problems.push(`${at}: an earlier step is already named "${name}".`);
      else produced.set(name, producedBy(step));
    }
  }

  for (const name of tool.returns) {
    if (!produced.has(name)) problems.push(`${label}: returns "${name}", which no step produces.`);
  }
}

function checkShow(step: Extract<PluginStep, { use: 'show' }>, at: string, tool: PluginTool, produced: ReadonlyMap<string, Produced>, context: ToolContext): void {
  const { manifest, problems, data, assetIds } = context;
  if (step.title !== undefined) checkValue(step.title, `${at}, "title"`, tool, produced, context);
  const board: PluginBoard | undefined = manifest.boards[step.board];
  if (board === undefined) problems.push(`${at}: there is no board "${step.board}" in "boards".`);

  const source = /^\$([a-z][a-z0-9_]*)$/.exec(step.items)?.[1];
  const from = source === undefined ? undefined : produced.get(source);
  if (from === undefined || (from.kind !== 'rows' && from.kind !== 'row')) {
    problems.push(`${at}: "items" must name an earlier draw or lookup step, like "$cards"; "${step.items}" does not.`);
    return;
  }
  if (board === undefined) return;
  const rows = data[from.table];
  if (rows === undefined) return;
  const fields = new Set([...columnsOf(rows), ...(from.kind === 'rows' ? DRAWN_FIELDS : [])]);
  const boardAt = `Board "${step.board}" (shown by ${at})`;
  const placeholders = (text: string, field: string) => {
    for (const path of templatePaths(text, `${boardAt}, "${field}"`, problems)) {
      const head = path.split('.')[0] ?? '';
      if (!fields.has(head)) problems.push(`${boardAt}, "${field}": {{${path}}} is not a field of "${from.table}"${from.kind === 'rows' ? ' or of a drawn row' : ''}.`);
    }
  };
  if (board.layout === 'cards') {
    if (!fields.has(board.image)) problems.push(`${boardAt}: "image" names "${board.image}", which is not a field of "${from.table}".`);
    else {
      const missing = rows.filter((row) => typeof row[board.image] !== 'string' || !assetIds.has(row[board.image] as string));
      if (missing.length > 0) {
        const first = missing[0]?.[board.image];
        problems.push(`${boardAt}: ${missing.length} row${missing.length === 1 ? '' : 's'} of "${from.table}" name${missing.length === 1 ? 's' : ''} an image that is not an asset (the first: ${JSON.stringify(first ?? null)}).`);
      }
    }
    if (board.flip !== undefined && !fields.has(board.flip)) problems.push(`${boardAt}: "flip" names "${board.flip}", which is not a field of "${from.table}"${from.kind === 'rows' ? ' or of a drawn row' : ''}.`);
    placeholders(board.caption, 'caption');
  } else {
    placeholders(board.line, 'line');
  }
}

function producedBy(step: PluginStep): Produced {
  switch (step.use) {
    case 'draw':
      return { kind: 'rows', table: step.table };
    case 'lookup':
      return { kind: 'row', table: step.table };
    case 'roll':
      return { kind: 'roll' };
    default:
      return { kind: 'value' };
  }
}

/** A step field: a reference, a template (a string with `{{ }}`), or a literal; arrays and objects are walked. */
function checkValue(value: unknown, at: string, tool: PluginTool, produced: ReadonlyMap<string, Produced>, context: ToolContext): void {
  if (typeof value === 'string') {
    if (value.startsWith('$')) checkPath(value.slice(1), at, tool, produced, context);
    else for (const path of templatePaths(value, at, context.problems)) checkPath(path, at, tool, produced, context);
  } else if (Array.isArray(value)) {
    for (const item of value) checkValue(item, at, tool, produced, context);
  } else if (isObject(value)) {
    for (const item of Object.values(value)) checkValue(item, at, tool, produced, context);
  }
}

function checkPath(path: string, at: string, tool: PluginTool, produced: ReadonlyMap<string, Produced>, context: ToolContext): void {
  const { problems, manifest, data } = context;
  const [head = '', next] = path.split('.');
  if (head === 'args') {
    if (next === undefined) problems.push(`${at}: $args needs a parameter's name, like $args.${Object.keys(tool.parameters)[0] ?? 'name'}.`);
    else if (!(next in tool.parameters)) problems.push(`${at}: "${path}" names a parameter "${next}" the tool does not have.`);
    return;
  }
  if (head === 'settings') {
    if (next === undefined) problems.push(`${at}: $settings needs a setting's key.`);
    else if (!(next in manifest.settings)) problems.push(`${at}: "${path}" names a setting "${next}" the plugin does not have.`);
    return;
  }
  const from = produced.get(head);
  if (from === undefined) {
    const later = tool.steps.some((step) => 'as' in step && step.as === head);
    problems.push(later ? `${at}: "${path}" reads step "${head}" before it runs.` : `${at}: "${path}" names nothing: not $args, $settings or an earlier step.`);
    return;
  }
  if (next === undefined) return;
  if (from.kind === 'roll' && !(ROLL_FIELDS as readonly string[]).includes(next)) problems.push(`${at}: "${path}": a roll has ${ROLL_FIELDS.join(' and ')}, not "${next}".`);
  if (from.kind === 'row') {
    const rows = data[from.table];
    if (rows !== undefined && !columnsOf(rows).has(next)) problems.push(`${at}: "${path}": "${next}" is not a field of "${from.table}".`);
  }
}

/** The `{{path}}` placeholders of a template, with a problem for each that is malformed. */
function templatePaths(text: string, at: string, problems: string[]): string[] {
  const paths: string[] = [];
  const stripped = text.replaceAll(/\{\{\s*([^{}]*?)\s*\}\}/g, (_whole, inner: string) => {
    if (/^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(inner)) paths.push(inner);
    else problems.push(`${at}: {{${inner}}} is not a path like {{name}} or {{spread.title}}.`);
    return '';
  });
  if (stripped.includes('{{') || stripped.includes('}}')) problems.push(`${at}: a "{{" or "}}" is not closed.`);
  return paths;
}

function tableFor(name: string, at: string, context: ToolContext): readonly PluginRow[] | null {
  if (!(name in context.manifest.data)) {
    context.problems.push(`${at}: there is no table "${name}" in "data".`);
    return null;
  }
  return context.data[name] ?? null; // null: the file itself was the problem, already said
}

function requireColumn(rows: readonly PluginRow[], table: string, column: string, at: string, problems: string[]): void {
  const without = rows.filter((row) => !(column in row)).length;
  if (without > 0) problems.push(`${at}: "${column}" is missing from ${without === rows.length ? 'every row' : `${without} rows`} of "${table}".`);
}

function columnsOf(rows: readonly PluginRow[]): Set<string> {
  return new Set(rows.flatMap((row) => Object.keys(row)));
}

async function readTable(name: string, path: string, folder: PluginFolder, problems: string[]): Promise<PluginRow[] | null> {
  const label = `Table "${name}" ("${path}")`;
  const text = await folder.text(path);
  if (text === null) {
    problems.push(`${label} is not in the folder.`);
    return null;
  }
  if (text.length > PLUGIN_LIMITS.tableChars) {
    problems.push(`${label} is ${text.length} characters; the most is ${PLUGIN_LIMITS.tableChars}.`);
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    problems.push(`${label} is not JSON: ${error instanceof Error ? error.message : String(error)}.`);
    return null;
  }
  if (!Array.isArray(value)) {
    problems.push(`${label} must be a JSON array of objects, one per row.`);
    return null;
  }
  if (value.length === 0) {
    problems.push(`${label} has no rows.`);
    return null;
  }
  if (value.length > PLUGIN_LIMITS.tableRows) {
    problems.push(`${label} has ${value.length} rows; the most is ${PLUGIN_LIMITS.tableRows}.`);
    return null;
  }
  const bad = value.findIndex((row) => !isObject(row));
  if (bad >= 0) {
    problems.push(`${label}: row ${bad + 1} is not an object.`);
    return null;
  }
  return value as PluginRow[];
}

// ── Small things ──────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duplicates(names: readonly string[], report: (name: string) => void): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) report(name);
    seen.add(name);
  }
}

function defaultFits(type: 'string' | 'number' | 'integer' | 'boolean', value: string | number | boolean): boolean {
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Major, minor, patch; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    const difference = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function versionParts(version: string): { readonly parts: number[]; readonly pre: string | undefined } {
  const [core = '', pre] = version.split('-', 2);
  return { parts: core.split('.').map(Number), pre };
}

/** The image type the bytes start with, or null when they are none of the three a plugin may ship. */
function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

/** `tools.0.steps.1.use` as `tools[0].steps[1].use`. */
function where(path: readonly PropertyKey[]): string {
  if (path.length === 0) return 'the top level';
  return path.map((part, index) => (typeof part === 'number' ? `[${part}]` : `${index === 0 ? '' : '.'}${String(part)}`)).join('');
}

function issueMessage(issue: { readonly code: string; readonly message: string; readonly path: readonly PropertyKey[]; readonly note?: unknown }): string {
  if (issue.code === 'invalid_union' && issue.note === 'No matching discriminator' && issue.path.at(-1) === 'use') {
    return `is not a primitive; the primitives are ${PLUGIN_PRIMITIVES.join(', ')}`;
  }
  return issue.message;
}
