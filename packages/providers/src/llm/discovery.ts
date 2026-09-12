import type { LlmModel } from '@latentpresence/protocol';

/** The fetch shape discovery needs. Kept structural so the module does not depend on the
 * AI SDK's own (un-exported) `FetchFunction`; the provider passes it straight through. The
 * DOM lib supplies `RequestInit`/`Response` for this browser package. */
export type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Model discovery (P1-T02), ported from latentCreate `crates/llm-bridge`.
 *
 * Two sources, verified by that crate against Ollama 0.32.15 on 2026-08-24
 * (LLM-SURFACE):
 * - **Ollama native** (`/api/tags`): one small call that carries capability data —
 *   `completion` (can it chat at all), `thinking`, `vision`, `tools` — plus context
 *   length and whether it runs on someone else's hardware. This is the only reliable
 *   signal for an embedding model, which `/v1/models` lists indistinguishably.
 * - **`/v1/models` fallback**: every other OpenAI-compatible endpoint. It carries nothing
 *   beyond model ids; capabilities are therefore `null` (ADR-22) and the caller must not
 *   present a guess as "can chat" or "local".
 */

/** Trims so `.../v1` and `.../v1/` build the same URL. A stray trailing slash pasted
 * out of a browser bar otherwise yields `//chat/completions`. */
export function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * The Ollama server root that matches an OpenAI-compatible base URL, when that URL looks
 * like Ollama's: everything before a trailing `/v1`. Returns null otherwise — LM Studio
 * and vLLM also end in `/v1`, so the caller must still confirm with `/api/version`.
 */
export function ollamaRootFromOpenAiBaseUrl(baseUrl: string): string | null {
  const trimmed = normaliseBaseUrl(baseUrl);
  if (!trimmed.endsWith('/v1')) return null;
  const root = trimmed.slice(0, -3);
  return root.length > 0 ? root : null;
}

/** One model as `/api/tags` lists it. Everything optional: the reference notes cloud
 * entries carry empty strings and `families` arrives as JSON null. */
interface OllamaTagsModel {
  name?: string;
  remote_host?: string | null;
  details?: {
    context_length?: number;
    parameter_size?: string;
  };
  capabilities?: string[];
}

interface OllamaTagsResponse {
  models?: OllamaTagsModel[];
}

interface V1ModelList {
  data?: Array<{ id?: string }>;
}

/** True when the server answers `/api/version` — the probe that says "this is Ollama",
 * since LM Studio and vLLM answer `/api/version` with a 404. */
export async function isOllama(fetchFn: HttpFetch, root: string): Promise<boolean> {
  try {
    const response = await fetchFn(`${root}/api/version`);
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes('"version"');
  } catch {
    return false;
  }
}

/** Every model from `/api/tags`, enriched. */
export async function ollamaModels(fetchFn: HttpFetch, root: string): Promise<LlmModel[]> {
  const response = await fetchFn(`${root}/api/tags`);
  if (!response.ok) {
    throw new Error(`ollama /api/tags ${response.status}`);
  }
  const body = JSON.parse(await response.text()) as OllamaTagsResponse;
  const models = body.models ?? [];
  return models
    .filter((m) => typeof m.name === 'string' && m.name.length > 0)
    .map((m) => fromOllamaModel(m));
}

function fromOllamaModel(m: OllamaTagsModel): LlmModel {
  const capabilities = m.capabilities ?? [];
  const canChat = capabilities.includes('completion');
  const contextLength = (m.details?.context_length ?? 0) > 0 ? (m.details?.context_length ?? null) : null;
  return {
    id: m.name as string,
    label: m.name as string,
    capabilities: {
      streaming: true,
      toolCalls: capabilities.includes('tools'),
      structuredOutput: false,
      thinking: capabilities.includes('thinking'),
      promptCaching: false,
      vision: capabilities.includes('vision'),
      contextLength,
    },
    embeddingOnly: !canChat,
  };
}

/** Model ids from `GET /v1/models`, in wire order. `created` is a file mtime on local
 * servers so it is deliberately ignored; only `id` is read (LLM-SURFACE 1). */
export async function v1Models(fetchFn: HttpFetch, baseUrl: string): Promise<LlmModel[]> {
  const response = await fetchFn(`${normaliseBaseUrl(baseUrl)}/models`);
  if (!response.ok) {
    throw new Error(`v1/models ${response.status}`);
  }
  const body = JSON.parse(await response.text()) as V1ModelList;
  return (body.data ?? [])
    .filter((entry) => typeof entry.id === 'string' && entry.id.length > 0)
    .map((entry) => ({
      id: entry.id as string,
      label: entry.id as string,
      capabilities: null,
      embeddingOnly: false,
    }));
}

export type DiscoverySource = 'ollama' | 'openai';

export interface DiscoveryResult {
  source: DiscoverySource;
  models: LlmModel[];
}

/**
 * List the models an endpoint offers. Tries the Ollama native enrichment when the base
 * URL looks like Ollama's and `/api/version` confirms it; anything else falls back to
 * `/v1/models` (capabilities unknown). Never guesses which endpoint — a base URL ending
 * in `/v1` that is not Ollama lands in the fallback with `source: 'openai'`.
 */
export async function discoverModels(
  fetchFn: HttpFetch,
  baseUrl: string,
): Promise<DiscoveryResult> {
  const base = normaliseBaseUrl(baseUrl);
  const root = ollamaRootFromOpenAiBaseUrl(base);
  if (root !== null && (await isOllama(fetchFn, root))) {
    return { source: 'ollama', models: await ollamaModels(fetchFn, root) };
  }
  return { source: 'openai', models: await v1Models(fetchFn, base) };
}
