import { z } from 'zod';
import { DEFAULT_COMPANION_URL } from '@latentpresence/providers/web';
import { KOKORO_DEFAULT_VOICE } from '@latentpresence/ml-web/voices';

/**
 * The settings document (P1-T10).
 *
 * One JSON object in `localStorage`, validated on load: corrupt or missing data falls
 * back to defaults rather than crashing the boot screen. **It never contains a key** —
 * keys live in the vault (`vault.ts`), referenced from here by a fixed ref per slot so
 * switching an LLM preset keeps that preset's own saved key.
 */

export const SETTINGS_STORAGE_KEY = 'latentpresence.settings.v1';

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

export const SettingsSchema = z.object({
  version: z.literal(1),
  companionUrl: z.string(),
  llm: LlmSettingsSchema,
  tts: TtsSettingsSchema,
  stt: SttSettingsSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;

/** No LLM chosen; Kokoro in the browser at the default voice and speed 1; Moonshine
 * tiny — the smallest download, since nothing has been agreed to yet (P1-T13). */
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  companionUrl: DEFAULT_COMPANION_URL,
  llm: { endpoint: null, baseUrl: '', modelId: null, temperature: null },
  tts: { kind: 'kokoro-browser', voiceId: KOKORO_DEFAULT_VOICE, speed: 1 },
  stt: { kind: 'moonshine-browser', model: 'moonshine-tiny' },
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

/** Load the settings document, falling back to defaults on missing or corrupt JSON —
 * never throws, so a wiped or hand-edited localStorage cannot crash the boot screen. */
export function loadSettings(storage: Pick<Storage, 'getItem'> = window.localStorage): Settings {
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const parsed = SettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Persist the settings document. Never call this with a key's text anywhere in
 * `settings` — the schema has no field for one, but a caller building the object by hand
 * could still add one, so callers must construct `Settings` only through this module's
 * types. */
export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> = window.localStorage): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
