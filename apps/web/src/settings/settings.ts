import { z } from 'zod';
import { McpTransportSchema } from '@latentpresence/protocol';
import { DEFAULT_COMPANION_URL } from '@latentpresence/providers/web';
import { KOKORO_DEFAULT_VOICE } from '@latentpresence/ml-web/voices';
import { DEFAULT_CHARACTER_ID, packFor } from '../characters/packs';
import { desktopShell } from '../desktop/desktop';
import { SETTINGS_STORAGE_KEY } from './welcomed';

/**
 * The settings document (P1-T10).
 *
 * One JSON object in `localStorage`, validated on load: corrupt or missing data falls
 * back to defaults rather than crashing the boot screen. **It never contains a key** —
 * keys live in the vault (`vault.ts`), referenced from here by a fixed ref per slot so
 * switching an LLM preset keeps that preset's own saved key.
 */

export { SETTINGS_STORAGE_KEY };

/** Temperature is never 0 — a thinking model given no budget for an answer spent its
 * whole budget reasoning and wrote nothing (P1-T02/T03). `null` means "server default",
 * which is not the same thing as 0. */
const TemperatureSchema = z
  .number()
  .min(0.1)
  .max(1.5)
  .nullable();

/** Above ~1.25 the server's phonemes degrade (P1-T05); below 0.75 speech drags. */
const SpeedSchema = z.number().min(0.75).max(1.25);

const LlmSettingsSchema = z.object({
  /** A preset id, `'anthropic'`, `'google'`, `'custom'`, or `null` when nothing is chosen. */
  endpoint: z.string().nullable(),
  /** Ignored for `anthropic`/`google`, which have no editable base URL. */
  baseUrl: z.string(),
  modelId: z.string().nullable(),
  temperature: TemperatureSchema,
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

const KokoroTtsSettingsSchema = z.object({
  kind: z.literal('kokoro-browser'),
  voiceId: z.string(),
  speed: SpeedSchema,
});

const OpenAiTtsSettingsSchema = z.object({
  kind: z.literal('openai-compatible'),
  baseUrl: z.string(),
  model: z.string(),
  voiceId: z.string(),
  speed: SpeedSchema,
});

const TtsSettingsSchema = z.discriminatedUnion('kind', [KokoroTtsSettingsSchema, OpenAiTtsSettingsSchema]);
export type TtsSettings = z.infer<typeof TtsSettingsSchema>;

const MoonshineSttSettingsSchema = z.object({
  kind: z.literal('moonshine-browser'),
  model: z.enum(['moonshine-tiny', 'moonshine-base']),
});

const WhisperSttSettingsSchema = z.object({
  kind: z.literal('whisper-browser'),
  model: z.enum(['whisper-base', 'whisper-tiny-en']),
});

const OpenAiSttSettingsSchema = z.object({
  kind: z.literal('openai-compatible'),
  baseUrl: z.string(),
  model: z.string(),
  language: z.string().nullable(),
});

const SttSettingsSchema = z.discriminatedUnion('kind', [
  MoonshineSttSettingsSchema,
  WhisperSttSettingsSchema,
  OpenAiSttSettingsSchema,
]);
export type SttSettings = z.infer<typeof SttSettingsSchema>;

/**
 * Where she remembers (P4-T04b, ADR-38). `auto` uses the companion when its `/health` says a
 * database is connected, and this browser's own storage otherwise; `off` remembers nothing.
 * **The default is `browser`**: `auto` asks the companion on every visit, and a request the
 * person never asked for is exactly what the face e2e test's "nothing off-origin before
 * consent" refuses (CI, 2026-09-28) — a hosted page probing `127.0.0.1` would also meet
 * Chrome's local-network rules. Defaulted, so a settings document saved before P4 still loads.
 */
export const MemorySettingSchema = z.enum(['auto', 'browser', 'companion', 'off']);
export type MemorySetting = z.infer<typeof MemorySettingSchema>;

/**
 * An MCP server the person added (P5-T01, ADR-42). `id` is minted once and never changes, so a
 * renamed server keeps its grants and its key (`mcpKeyRef(id)` in the vault when `auth` is
 * `bearer`). No stdio here: only the companion starts processes, from its own config.
 */
export const ToolServerSettingSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(40),
  url: z.string().min(1),
  transport: McpTransportSchema,
  enabled: z.boolean(),
  auth: z.enum(['none', 'bearer']),
});
export type ToolServerSetting = z.infer<typeof ToolServerSettingSchema>;

/** The person's decision about one tool: auto (with the fingerprint it was trusted at), ask, never. */
export const ToolGrantSettingSchema = z.object({
  policy: z.enum(['auto', 'ask', 'never']),
  fingerprint: z.string().nullable(),
});

export const ToolsSettingsSchema = z.object({
  servers: z.array(ToolServerSettingSchema).max(16),
  /** By server id, then by the server's own tool name. A tool with no entry is asked about. */
  grants: z.record(z.string(), z.record(z.string(), ToolGrantSettingSchema)),
  /**
   * Offer the tools of the servers the companion runs from its own `mcp.json` (P5-T02, ADR-43).
   * Off by default: a page reaching for `127.0.0.1` unasked is what memory's default avoids too.
   * Their grants are under `companion:<name>`. Defaulted, so a document saved in P5-T01 loads.
   */
  companion: z.boolean().default(false),
  /**
   * The Home Assistant area they talk to her from (P5-T07, ADR-48): "the light" means that
   * room's. Null, no room is assumed. Device policies sit in `grants` under `device:<name>`.
   */
  homeArea: z.string().min(1).max(200).nullable().default(null),
});
export type ToolsSettings = z.infer<typeof ToolsSettingsSchema>;

/**
 * Her search of the person's documents (P5-T04, ADR-45). Off by default: turning it on makes the
 * page ask the companion at `127.0.0.1` whether it has documents, which an unasked request
 * must not do (the same reason memory defaults to `browser`). Defaulted, so a document saved
 * before P5-T04 loads.
 */
export const DocumentsSettingsSchema = z.object({
  search: z.boolean(),
});
export type DocumentsSettings = z.infer<typeof DocumentsSettingsSchema>;

/**
 * How often she speaks up on her own (P6-T03, ADR-52): off, rare or normal. Off also turns off
 * the opener when they come back (ADR-51). Defaulted, so a document saved before P6 loads.
 */
export const InitiativeSettingSchema = z.enum(['off', 'rare', 'normal']);
export type InitiativeSetting = z.infer<typeof InitiativeSettingSchema>;

/**
 * One character's own voice (P6-T06, ADR-55) and body (P7-T02, ADR-59). The voice: the engine it was chosen for, and the voice and
 * speed on it. Used only while that engine is the one in use (`characterVoice`). `null` is no
 * choice: the persona's voice on Kokoro, the one in Settings → Voice on any other engine.
 */
export const CharacterSettingsSchema = z.object({
  voice: z
    .object({
      kind: z.enum(['kokoro-browser', 'openai-compatible']),
      voiceId: z.string().min(1),
      speed: SpeedSchema,
    })
    .nullable(),
  /** P7-T02 (ADR-59): the body this character wears, a built-in id or an own body's `own:` id;
   * `null`, or a body no longer there, is the pack's default. Defaulted, so older documents load. */
  body: z.string().min(1).nullable().default(null),
});
export type CharacterSettings = z.infer<typeof CharacterSettingsSchema>;

export const SettingsSchema = z.object({
  version: z.literal(1),
  companionUrl: z.string(),
  memory: MemorySettingSchema.default('browser'),
  /** Defaulted, so a settings document saved before P5 still loads. */
  tools: ToolsSettingsSchema.default({ servers: [], grants: {}, companion: false, homeArea: null }),
  /** P5-T04, ADR-45: off by default, no unasked request to `127.0.0.1`. */
  documents: DocumentsSettingsSchema.default({ search: false }),
  /** P6-T03, ADR-52. */
  initiative: InitiativeSettingSchema.default('normal'),
  /** P6-T06, ADR-55: the active character's id (an unknown one is Alice's) and each one's voice. Defaulted. */
  character: z.string().min(1).default(DEFAULT_CHARACTER_ID),
  characters: z.record(z.string(), CharacterSettingsSchema).default({}),
  llm: LlmSettingsSchema,
  tts: TtsSettingsSchema,
  stt: SttSettingsSchema,
  /**
   * Whether the first-run wizard (P8-T02) has been finished or skipped. `/` shows the wizard
   * until it is. Defaulted, so a document saved before P8-T02 loads; `loadSettings` reads such
   * a document with a language model chosen as already welcomed (`markWelcomed`).
   */
  welcomed: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** No LLM chosen; Kokoro in the browser at the default voice and speed 1; Moonshine
 * tiny — the smallest download, since nothing has been agreed to yet (P1-T13). */
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  companionUrl: DEFAULT_COMPANION_URL,
  memory: 'browser',
  tools: { servers: [], grants: {}, companion: false, homeArea: null },
  documents: { search: false },
  initiative: 'normal',
  character: DEFAULT_CHARACTER_ID,
  characters: {},
  llm: { endpoint: null, baseUrl: '', modelId: null, temperature: null },
  tts: { kind: 'kokoro-browser', voiceId: KOKORO_DEFAULT_VOICE, speed: 1 },
  stt: { kind: 'moonshine-browser', model: 'moonshine-tiny' },
  welcomed: false,
};

/** The vault ref for an LLM endpoint's key. Keyed by endpoint id so switching presets
 * keeps each one's own saved key rather than overwriting a shared slot. */
export function llmKeyRef(endpoint: string): string {
  return `llm:${endpoint}`;
}

/** The vault ref for the TTS server's key. One slot: only one server is configured at a
 * time, unlike the LLM's per-preset refs. */
export const TTS_KEY_REF = 'tts';

/** The vault ref for the STT server's key. */
export const STT_KEY_REF = 'stt';

/** The vault ref for an MCP server's bearer token, by the server's id. */
export function mcpKeyRef(serverId: string): string {
  return `mcp:${serverId}`;
}

function hasCharacters(stored: unknown): boolean {
  return typeof stored === 'object' && stored !== null && 'characters' in stored;
}

/**
 * A document saved before characters (P6-T06, ADR-55) chose its Kokoro voice for the one
 * character there was. Written as hers on first load, so Alice keeps it and Theo gets his own.
 * A voice that is already Alice's own needs no saved choice; another engine is one voice for
 * all, as it still is.
 */
function keepVoiceForAlice(settings: Settings): Settings {
  const { tts } = settings;
  if (tts.kind !== 'kokoro-browser' || tts.voiceId === packFor(DEFAULT_CHARACTER_ID).persona.voice.voiceId) return settings;
  return { ...settings, characters: { ...settings.characters, [DEFAULT_CHARACTER_ID]: { body: null, ...settings.characters[DEFAULT_CHARACTER_ID], voice: { kind: tts.kind, voiceId: tts.voiceId, speed: tts.speed } } } };
}

function hasWelcomed(stored: unknown): boolean {
  return typeof stored === 'object' && stored !== null && 'welcomed' in stored;
}

/**
 * A document saved before the first-run wizard (P8-T02) has no `welcomed`. Someone who had
 * already chosen a language model has been through setup in all but name, and must not meet a
 * wizard on their next visit; a document with none chosen has not, and keeps the default.
 */
function markWelcomed(settings: Settings): Settings {
  return settings.llm.modelId === null ? settings : { ...settings, welcomed: true };
}

/** The settings with `body` chosen for one character (P7-T02, ADR-59), its voice kept. `null` is its pack's default. */
export function withBodyChoice(settings: Settings, characterId: string, body: string | null): Settings {
  const current = settings.characters[characterId] ?? { voice: null, body: null };
  return { ...settings, characters: { ...settings.characters, [characterId]: { ...current, body } } };
}

/** Load the settings document, falling back to defaults on missing or corrupt JSON —
 * never throws, so a wiped or hand-edited localStorage cannot crash the boot screen. */
export function loadSettings(storage: Pick<Storage, 'getItem'> = window.localStorage): Settings {
  return withShellCompanion(loadStored(storage));
}

function loadStored(storage: Pick<Storage, 'getItem'>): Settings {
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const stored: unknown = JSON.parse(raw);
    const parsed = SettingsSchema.safeParse(stored);
    if (!parsed.success) return DEFAULT_SETTINGS;
    const migrated = hasCharacters(stored) ? parsed.data : keepVoiceForAlice(parsed.data);
    return hasWelcomed(stored) ? migrated : markWelcomed(migrated);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** In the desktop app the companion is the app's own, wherever it is listening (P8-T01). */
function withShellCompanion(settings: Settings): Settings {
  const shell = desktopShell();
  return shell === null ? settings : { ...settings, companionUrl: shell.companionUrl };
}

/** Persist the settings document. Never call this with a key's text anywhere in
 * `settings` — the schema has no field for one, but a caller building the object by hand
 * could still add one, so callers must construct `Settings` only through this module's
 * types. */
export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> = window.localStorage): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
