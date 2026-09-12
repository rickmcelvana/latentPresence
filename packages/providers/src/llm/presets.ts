/**
 * The bundled LLM endpoint presets (P1-T02).
 *
 * Each entry is an OpenAI-compatible base URL plus what the settings UI needs to
 * render it. Local defaults are the documented server defaults; the cloud base URLs
 * are recorded in `docs/SURFACE.md` with their references and a 2026-09-11 date.
 * Only `native: 'ollama'` carries the capability enrichment (`/api/tags`); every
 * other endpoint is discovered through `/v1/models`, whose capabilities are unknown
 * (ADR-22, latentCreate LLM-SURFACE 11).
 */
export interface LLMPreset {
  /** Stable id, the value stored in settings. */
  readonly id: string;
  /** Human-facing name. */
  readonly label: string;
  /** Default OpenAI-compatible base URL; the user may edit it. */
  readonly baseUrl: string;
  /** Cloud endpoints need a key the settings UI must collect. */
  readonly requiresApiKey: boolean;
  /** 'ollama' enables the native `/api/tags` enrichment layer. */
  readonly native?: 'ollama';
  /** Short usage note for the settings UI. */
  readonly hint?: string;
}

export const llmPresets: readonly LLMPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false,
    native: 'ollama',
  },
  {
    id: 'lm-studio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresApiKey: false,
  },
  {
    id: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    requiresApiKey: false,
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp',
    baseUrl: 'http://localhost:8080/v1',
    requiresApiKey: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    requiresApiKey: true,
    hint: 'API key from build.nvidia.com',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresApiKey: true,
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    requiresApiKey: true,
  },
];

const byId = (id: string) => llmPresets.find((p) => p.id === id);

/** A preset by id, or undefined. */
export function presetById(id: string): LLMPreset | undefined {
  return byId(id);
}
