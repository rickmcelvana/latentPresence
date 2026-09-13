import type { LLMProvider, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import {
  AnthropicLLMProvider,
  GoogleLLMProvider,
  OpenAICompatibleLLMProvider,
} from '@latentpresence/providers';

/**
 * The live LLM check (`docs/TASKS.md`).
 *
 * Hand-run, never gated, no fixtures: it drives the real provider classes against real
 * endpoints and asserts the four things P1-T02 and P1-T03 promised and never evidenced —
 * text streams, a tool call arrives as its own `tool-call` chunk, reasoning stays out of
 * `text-delta`, and the run ends with `finish`.
 *
 * Keys come from `.env`; a target whose key is missing is skipped, not failed.
 *
 * `temperature` is deliberately left null. Setting it to 0 made `qwen3.5:9b` think until
 * it ran out of budget and never speak at all (2026-09-12) — see `docs/SURFACE.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

interface Target {
  readonly label: string;
  readonly provider: LLMProvider;
  readonly modelId: string;
  /** Skip when this is missing, naming what is missing. */
  readonly needs?: string | undefined;
}

const WEATHER = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
};

function ask(modelId: string, prompt: string, tools: boolean): LlmRequest {
  return {
    modelId,
    messages: [{ role: 'user', content: prompt }],
    tools: tools ? [WEATHER] : [],
    temperature: null,
    maxOutputTokens: 2000,
  };
}

interface Result {
  textDeltas: number;
  reasoningDeltas: number;
  toolCalls: string[];
  finish: string | null;
  text: string;
  ms: number;
  error: string | null;
}

async function run(provider: LLMProvider, request: LlmRequest): Promise<Result> {
  const started = Date.now();
  const result: Result = {
    textDeltas: 0,
    reasoningDeltas: 0,
    toolCalls: [],
    finish: null,
    text: '',
    ms: 0,
    error: null,
  };
  try {
    for await (const chunk of provider.stream(request) as AsyncIterable<LlmStreamChunk>) {
      if (chunk.type === 'text-delta') {
        result.textDeltas += 1;
        result.text += chunk.text;
      } else if (chunk.type === 'reasoning-delta') {
        result.reasoningDeltas += 1;
      } else if (chunk.type === 'tool-call') {
        result.toolCalls.push(`${chunk.call.name}(${JSON.stringify(chunk.call.arguments)})`);
      } else {
        result.finish = chunk.reason;
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.ms = Date.now() - started;
  return result;
}

const openAiCompatible = (
  id: string,
  baseUrl: string,
  apiKey: string | undefined,
): LLMProvider =>
  new OpenAICompatibleLLMProvider({ id, baseUrl, ...(apiKey === undefined ? {} : { apiKey }) });

const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';

const targets: Target[] = [
  {
    label: 'ollama local',
    provider: openAiCompatible('ollama', OLLAMA, undefined),
    modelId: 'qwen3.5:9b',
  },
  {
    label: 'ollama cloud',
    provider: openAiCompatible('ollama', OLLAMA, undefined),
    modelId: 'qwen3.5:397b-cloud',
  },
  {
    label: 'lm studio',
    provider: openAiCompatible('lm-studio', 'http://localhost:1234/v1', undefined),
    modelId: 'qwen/qwen3.5-9b',
  },
  {
    label: 'nvidia',
    provider: openAiCompatible(
      'nvidia',
      'https://integrate.api.nvidia.com/v1',
      env('NVIDIA_API_KEY'),
    ),
    modelId: 'nvidia/nemotron-3-super-120b-a12b',
    needs: env('NVIDIA_API_KEY') === undefined ? 'NVIDIA_API_KEY' : undefined,
  },
  {
    label: 'deepseek',
    provider: openAiCompatible('deepseek', 'https://api.deepseek.com/v1', env('DEEPSEEK_API_KEY')),
    modelId: 'deepseek-v4-pro',
    needs: env('DEEPSEEK_API_KEY') === undefined ? 'DEEPSEEK_API_KEY' : undefined,
  },
  {
    label: 'qwen (openai-compat)',
    provider: openAiCompatible(
      'qwen',
      env('QWEN_OPENAI_BASE_URL') ?? '',
      env('QWEN_API_KEY'),
    ),
    modelId: 'qwen3.8-flash',
    needs: env('QWEN_API_KEY') === undefined ? 'QWEN_API_KEY' : undefined,
  },
  {
    label: 'anthropic (native)',
    provider: new AnthropicLLMProvider({
      id: 'anthropic',
      ...(env('ANTHROPIC_API_KEY') === undefined ? {} : { apiKey: env('ANTHROPIC_API_KEY') ?? '' }),
    }),
    modelId: 'claude-opus-5',
    needs: env('ANTHROPIC_API_KEY') === undefined ? 'ANTHROPIC_API_KEY' : undefined,
  },
  {
    // The point of this one: `baseUrl` on the native adapter has no live coverage at all.
    label: 'qwen via anthropic adapter',
    provider: new AnthropicLLMProvider({
      id: 'qwen-anthropic',
      ...(env('QWEN_API_KEY') === undefined ? {} : { apiKey: env('QWEN_API_KEY') ?? '' }),
      ...(env('QWEN_ANTHROPIC_BASE_URL') === undefined
        ? {}
        : { baseUrl: env('QWEN_ANTHROPIC_BASE_URL') ?? '' }),
    }),
    modelId: 'qwen3.8-flash',
    needs: env('QWEN_ANTHROPIC_BASE_URL') === undefined ? 'QWEN_ANTHROPIC_BASE_URL' : undefined,
  },
  {
    label: 'google (native)',
    provider: new GoogleLLMProvider({
      id: 'google',
      ...(env('GOOGLE_GENERATIVE_AI_API_KEY') === undefined
        ? {}
        : { apiKey: env('GOOGLE_GENERATIVE_AI_API_KEY') ?? '' }),
    }),
    modelId: 'gemini-3.5-flash',
    needs: env('GOOGLE_GENERATIVE_AI_API_KEY') === undefined
      ? 'GOOGLE_GENERATIVE_AI_API_KEY'
      : undefined,
  },
];

function line(label: string, kind: string, result: Result): string {
  const snippet = result.text.replaceAll(/\s+/gu, ' ').trim().slice(0, 52);
  const verdict =
    result.error !== null
      ? 'FAIL'
      : result.finish === null
        ? 'NOFIN'
        : kind === 'tool' && result.toolCalls.length === 0
          ? 'NOTOOL'
          : kind === 'text' && result.textDeltas === 0
            ? 'NOTEXT'
            : 'ok';
  return [
    verdict.padEnd(6),
    label.padEnd(27),
    kind.padEnd(4),
    `txt=${String(result.textDeltas).padStart(4)}`,
    `rsn=${String(result.reasoningDeltas).padStart(4)}`,
    `fin=${(result.finish ?? '-').padEnd(10)}`,
    `${String(result.ms).padStart(6)}ms`,
    result.error === null
      ? kind === 'tool'
        ? `| ${result.toolCalls.join(';') || '(none)'}`
        : `| ${snippet}`
      : `| ${result.error.slice(0, 110)}`,
  ].join('  ');
}

for (const target of targets) {
  if (target.needs !== undefined) {
    console.log(`skip    ${target.label.padEnd(27)}  (no ${target.needs})`);
    continue;
  }
  console.log(
    line(target.label, 'text', await run(target.provider, ask(target.modelId, 'Say hello in one short sentence.', false))),
  );
  console.log(
    line(target.label, 'tool', await run(target.provider, ask(target.modelId, 'What is the weather in Oslo? Use the tool.', true))),
  );
}
