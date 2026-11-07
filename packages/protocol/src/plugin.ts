import { z } from 'zod';
import { CatchUpPolicySchema, DeliveryModeSchema } from './schedule';
import { JsonValueSchema, UnitIntervalSchema } from './common';

/**
 * A plugin, as a file (ADR-72, P10-T01).
 *
 * A plugin is a folder holding `plugin.json` and the files it names. Like a persona it is
 * **content, not code**: nothing in it runs in the page. Its tools are steps over a small set
 * of primitives the core runs (P10-T02); anything a primitive cannot do belongs in an MCP
 * server the plugin asks for, behind the same gate as every other outside tool.
 *
 * This file is the shape only. Whether the names in it point at something — a table a step
 * reads, a board a step shows, a file on disk, an asset's hash — is `checkPlugin` in core,
 * because answering needs the folder's other files. The JSON Schema authors validate against
 * in an editor is generated from this (`pnpm plugin:schema`).
 *
 * Objects are strict: in a hand-written file an unknown key is nearly always a typo
 * (`tool` for `tools`), and a typo that parses is a feature that silently is not there.
 */

/** Bumped when a field changes meaning. A newer format is refused by name, not by a parse error. */
export const PLUGIN_FORMAT = 1;

/**
 * The plugin's namespace: its tools are `<id>__<tool>`, its data `_plugin:<id>`. 24 characters,
 * so `<id>__<tool>` stays inside the 64 a model provider accepts for a tool's name.
 */
export const PluginIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,23}$/, { error: 'must be 2 to 24 characters: lowercase letters, digits and hyphens, starting with a letter' });

/** A name inside a plugin: a tool, a table, a step, a board, a setting, an MCP server. */
export const PluginNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, { error: 'must be 1 to 32 characters: lowercase letters, digits and underscores, starting with a letter' });

const AssetIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, { error: 'must be 1 to 64 characters: lowercase letters, digits, hyphens and underscores' });

/**
 * A path inside the plugin's folder: forward slashes, no `..`, nothing absolute, no hidden
 * files. A segment cannot start with a dot, which rules out `.` and `..` as well.
 */
export const PluginPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/, {
    error: 'must be a path inside the plugin folder, with forward slashes and no ".."',
  });

const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, { error: 'must be a version like 1.2.0' });

/** Assets and pages travel over https only; the page policy and the pinned fetch both assume it. */
const HttpsUrlSchema = z.url({ protocol: /^https$/, error: 'must be an https address' });

/**
 * A reference: `$args.<parameter>`, `$settings.<key>`, or `$<step>` and a path into what that
 * step produced. **Any string value that starts with `$` is a reference.** Templates use the
 * same paths without the `$`, inside `{{ }}`.
 */
export const PluginRefSchema = z
  .string()
  .regex(/^\$[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*$/, { error: 'must be a reference like $args.spread or $cards' });

const refOr = <T extends z.ZodType>(schema: T) => z.union([PluginRefSchema, schema]);

const TemplateTextSchema = z.string().min(1).max(2000);

// ── Tools ─────────────────────────────────────────────────────────────────────

/** A tool's argument, as the model fills it. Kept to what every provider's tool schema can say. */
export const PluginParameterSchema = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  description: z.string().min(1).max(300),
  /** The only values the model may give. */
  enum: z.array(z.string().min(1).max(100)).min(1).max(100).optional(),
  /** The values of one column of a data table, as the enum (`spreads`'s `id`, say). */
  enumFrom: z.strictObject({ table: PluginNameSchema, column: z.string().min(1).max(64) }).optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});
export type PluginParameter = z.infer<typeof PluginParameterSchema>;

/**
 * Draws rows from a table without putting them back. Each drawn row is the table's row plus
 * `reversed` (a boolean) and `slot` (its label, when `slots` is given, else its position from 1).
 * `reversed` is the chance each row is drawn reversed; `true` is a half.
 */
const DrawStepSchema = z.strictObject({
  use: z.literal('draw'),
  as: PluginNameSchema,
  table: PluginNameSchema,
  /** How many; defaults to the number of slots, else one. */
  count: refOr(z.number().int().min(1).max(100)).optional(),
  /** Labels for the drawn rows, in order — a spread's positions. */
  slots: refOr(z.array(z.string().min(1).max(60)).min(1).max(100)).optional(),
  reversed: refOr(z.union([UnitIntervalSchema, z.boolean()])).default(0),
});

/** Dice notation, `d20`, `3d6`, `2d10+1`: produces `{ total, rolls }`. */
const RollStepSchema = z.strictObject({
  use: z.literal('roll'),
  as: PluginNameSchema,
  dice: refOr(z.string().regex(/^\d{0,2}d\d{1,3}([+-]\d{1,3})?$/, { error: 'must be dice notation like d20, 3d6 or 2d10+1' })),
});

/** The row of a table whose `by` column equals `key`. */
const LookupStepSchema = z.strictObject({
  use: z.literal('lookup'),
  as: PluginNameSchema,
  table: PluginNameSchema,
  key: refOr(z.union([z.string().min(1), z.number()])),
  by: z.string().min(1).max(64).default('id'),
});

/** A string with `{{path}}` filled from the arguments, the settings and earlier steps. */
const TemplateStepSchema = z.strictObject({
  use: z.literal('template'),
  as: PluginNameSchema,
  text: TemplateTextSchema,
});

/** The plugin's own data for this character (ADR-72 item 5). `get` produces the value, or null. */
const StateStepSchema = z
  .strictObject({
    use: z.literal('state'),
    as: PluginNameSchema.optional(),
    op: z.enum(['get', 'set', 'append', 'clear']),
    key: PluginNameSchema,
    value: z.union([PluginRefSchema, JsonValueSchema]).optional(),
  })
  .refine((step) => (step.op === 'set' || step.op === 'append') === (step.value !== undefined), {
    error: 'a "set" or "append" needs a value, and a "get" or "clear" takes none',
  })
  .refine((step) => step.op !== 'get' || step.as !== undefined, { error: 'a "get" needs an "as" to name what it read', path: ['as'] });

/** Puts what a `draw` or `lookup` produced on a board (ADR-72 item 6). */
const ShowStepSchema = z.strictObject({
  use: z.literal('show'),
  board: PluginNameSchema,
  items: PluginRefSchema,
  title: refOr(TemplateTextSchema).optional(),
});

export const PluginStepSchema = z.discriminatedUnion('use', [DrawStepSchema, RollStepSchema, LookupStepSchema, TemplateStepSchema, StateStepSchema, ShowStepSchema]);
export type PluginStep = z.infer<typeof PluginStepSchema>;
export type PluginPrimitive = PluginStep['use'];
export const PLUGIN_PRIMITIVES: readonly PluginPrimitive[] = ['draw', 'roll', 'lookup', 'template', 'state', 'show'];

export const PluginToolSchema = z.strictObject({
  name: PluginNameSchema,
  /** What the model reads to decide when to call it. */
  description: z.string().min(1).max(500),
  parameters: z.record(PluginNameSchema, PluginParameterSchema).default({}),
  steps: z.array(PluginStepSchema).min(1).max(20),
  /** The steps whose results the model reads, by their `as`. */
  returns: z.array(PluginNameSchema).min(1).max(20),
  /** The primitives touch nothing outside the plugin, so `auto`; a plugin may ask for `ask`. */
  policy: z.enum(['auto', 'ask']).default('auto'),
});
export type PluginTool = z.infer<typeof PluginToolSchema>;

// ── Data, assets, boards ──────────────────────────────────────────────────────

/** A file the plugin shows. Pinned: the bytes and their SHA-256 are the consent and the check (ADR-70). */
export const PluginAssetSchema = z
  .strictObject({
    id: AssetIdSchema,
    /** In the plugin's folder… */
    path: PluginPathSchema.optional(),
    /** …or on a server that sends CORS. */
    url: HttpsUrlSchema.optional(),
    type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    bytes: z.number().int().min(1).max(20_000_000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: 'must be 64 lowercase hex characters' }),
    licence: z.string().min(1).max(100),
    /** Where it came from, for a person to read: a title, an address. */
    source: z.string().min(1).max(300),
  })
  .refine((asset) => (asset.path === undefined) !== (asset.url === undefined), { error: 'an asset needs a "path" or a "url", not both' });
export type PluginAsset = z.infer<typeof PluginAssetSchema>;

/**
 * How shown items look. `cards`: an image per item from the asset named in its `image` field,
 * rotated 180° (still face up) when its `flip` field is true, captioned by a template over its fields. `list`:
 * a line per item. On the screen unless it says the whiteboard (ADR-49).
 */
export const PluginBoardSchema = z.discriminatedUnion('layout', [
  z.strictObject({
    layout: z.literal('cards'),
    where: z.enum(['screen', 'whiteboard']).default('screen'),
    image: z.string().min(1).max(64),
    caption: TemplateTextSchema,
    flip: z.string().min(1).max(64).optional(),
  }),
  z.strictObject({
    layout: z.literal('list'),
    where: z.enum(['screen', 'whiteboard']).default('screen'),
    line: TemplateTextSchema,
  }),
]);
export type PluginBoard = z.infer<typeof PluginBoardSchema>;

// ── MCP, schedules, settings ──────────────────────────────────────────────────

/** A server the plugin asks for (ADR-72 item 7). Nothing is added until the person says yes. */
export const PluginMcpServerSchema = z.discriminatedUnion('transport', [
  z.strictObject({ id: PluginNameSchema, name: z.string().min(1).max(60), transport: z.literal('http'), url: HttpsUrlSchema }),
  z.strictObject({
    id: PluginNameSchema,
    name: z.string().min(1).max(60),
    transport: z.literal('stdio'),
    command: z.string().min(1).max(200),
    args: z.array(z.string().max(500)).max(40).default([]),
  }),
]);
export type PluginMcpServer = z.infer<typeof PluginMcpServerSchema>;

/**
 * The app's own tools a schedule preset may name besides the plugin's (ADR-73): her plans and
 * schedules, to read, and any tool of the companion's Files server as `files__<tool>`.
 */
export const PLUGIN_APP_TOOLS: readonly string[] = ['plan_list', 'schedule_list'];
export const PLUGIN_APP_SERVER = 'files';

/**
 * A schedule offered when the plugin is enabled, in the person's own time zone. `tools` names
 * the plugin's tools, `<mcp id>__<tool>` for one of its servers' tools, or one of the app's
 * (`PLUGIN_APP_TOOLS`, `files__<tool>`).
 */
export const PluginSchedulePresetSchema = z.strictObject({
  id: PluginNameSchema,
  description: z.string().min(1).max(200),
  cron: z.string().min(1).max(100),
  taskPrompt: z.string().max(2000),
  tools: z.array(z.string().min(1).max(64)).max(20).default([]),
  delivery: DeliveryModeSchema,
  catchUp: CatchUpPolicySchema.default('skip'),
});
export type PluginSchedulePreset = z.infer<typeof PluginSchedulePresetSchema>;

/** A field the person fills in Settings → Plugins, read as `$settings.<key>`. */
export const PluginSettingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), label: z.string().min(1).max(60), default: z.string().max(500) }),
  z.strictObject({ type: z.literal('number'), label: z.string().min(1).max(60), default: z.number(), minimum: z.number().optional(), maximum: z.number().optional() }),
  z.strictObject({ type: z.literal('switch'), label: z.string().min(1).max(60), default: z.boolean() }),
  z.strictObject({ type: z.literal('choice'), label: z.string().min(1).max(60), choices: z.array(z.string().min(1).max(60)).min(2).max(20), default: z.string().min(1) }),
]);
export type PluginSetting = z.infer<typeof PluginSettingSchema>;

// ── The manifest ──────────────────────────────────────────────────────────────

export const PluginManifestSchema = z.strictObject({
  /** For editors: where the JSON Schema is. Ignored by the app. */
  $schema: z.string().optional(),
  format: z.literal(PLUGIN_FORMAT),
  id: PluginIdSchema,
  name: z.string().min(1).max(60),
  version: SemverSchema,
  author: z.string().min(1).max(100),
  /** The plugin's own licence; each asset states its own. */
  licence: z.string().min(1).max(100),
  homepage: HttpsUrlSchema.optional(),
  /** The one line the model sees while the plugin is enabled and not yet used (ADR-72 item 4). */
  summary: z.string().min(1).max(200),
  /** The oldest app version it works with. */
  minApp: SemverSchema,
  /** A Markdown file: when and how she uses it. Joins the prompt once the plugin is used. */
  instructions: PluginPathSchema,
  /** Tables by name: each a JSON file holding an array of objects. */
  data: z.record(PluginNameSchema, PluginPathSchema).default({}),
  assets: z.array(PluginAssetSchema).max(500).default([]),
  tools: z.array(PluginToolSchema).max(20).default([]),
  boards: z.record(PluginNameSchema, PluginBoardSchema).default({}),
  mcp: z.array(PluginMcpServerSchema).max(10).default([]),
  schedules: z.array(PluginSchedulePresetSchema).max(10).default([]),
  settings: z.record(PluginNameSchema, PluginSettingSchema).default({}),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;

/** The JSON Schema an author's editor validates `plugin.json` against (`pnpm plugin:schema`). */
export function pluginManifestJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(PluginManifestSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { ...schema, title: 'latentPresence plugin manifest', description: `plugin.json, format ${PLUGIN_FORMAT} (ADR-72). Cross-references are checked by \`pnpm plugin:check\`.` };
}

// ── The index (ADR-72 item 9, P10-T09) ────────────────────────────────────────

/** Bumped when a field of the index changes meaning. */
export const PLUGIN_INDEX_FORMAT = 1;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, { error: 'must be 64 lowercase hex characters' });

/**
 * One plugin in the index. The manifest's address should name a fixed version (a commit, not a
 * branch). `sha256` is the manifest's and `files` every other file of the folder the manifest names
 * (its instructions, its data, assets kept in the folder): a plugin changed in any of them after it
 * was listed is refused until the index is updated. Assets at an address are pinned by the
 * manifest itself.
 */
export const PluginIndexEntrySchema = z.strictObject({
  id: PluginIdSchema,
  name: z.string().min(1).max(60),
  summary: z.string().min(1).max(200),
  author: z.string().min(1).max(100),
  version: SemverSchema,
  licence: z.string().min(1).max(100),
  tags: z.array(z.string().min(1).max(30)).max(10).default([]),
  manifest: HttpsUrlSchema,
  sha256: Sha256Schema,
  files: z.record(PluginPathSchema, Sha256Schema).default({}),
});
export type PluginIndexEntry = z.infer<typeof PluginIndexEntrySchema>;

/** `plugins/index.json` on latentpresence.com, curated by pull request in the site's repository. */
export const PluginIndexSchema = z.strictObject({
  $schema: z.string().optional(),
  format: z.literal(PLUGIN_INDEX_FORMAT),
  plugins: z.array(PluginIndexEntrySchema).max(500),
});
export type PluginIndex = z.infer<typeof PluginIndexSchema>;

/** The JSON Schema published beside the index (`pnpm plugin:schema`). */
export function pluginIndexJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(PluginIndexSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { ...schema, title: 'latentPresence plugin index', description: `plugins/index.json, format ${PLUGIN_INDEX_FORMAT} (ADR-72 item 9). Written by \`pnpm plugin:index\`.` };
}
