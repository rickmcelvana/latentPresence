import { PermissionPrompts, mcpTools, renderSystemPrompt, withLocalTools, type ConnectedToolServer, type ToolGrant, type ToolGrants } from '@latentpresence/core';
import { PersonaSchema, type JsonValue, type ToolCall } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider, connectMcpServer } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live MCP check (P5-T01, `pnpm live:mcp`): P5-T01's done-when outside the page — a public
 * demo server (DeepWiki, streamable HTTP, no key) connected through `@ai-sdk/mcp`, its tools
 * offered to a real model through `mcpTools` and `withLocalTools`, **every call stopped at the
 * "ask" gate** and answered here (Allow once), then run against the live server. Counts: did she
 * call a DeepWiki tool, was she asked first, did the answer use what came back. A second pass
 * answers Deny and checks she carries on without it. `MCP_RUNS=3` repeats. Hand-run, never
 * gated. Writes `live/out/mcp.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const modelId = env('MCP_OLLAMA_MODEL') ?? 'glm-5.2:cloud';
const SERVER_URL = env('MCP_URL') ?? 'https://mcp.deepwiki.com/mcp';
const RUNS = Number(env('MCP_RUNS') ?? '1');
const QUESTION = 'What topics does the documentation for the GitHub repo vercel/ai cover? Look it up.';

const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };

const started = performance.now();
const client = await connectMcpServer({ url: SERVER_URL, transport: 'http' });
const tools = await client.listTools();
console.log(`${client.serverName}: ${tools.map((tool) => tool.name).join(', ')} (${Math.round(performance.now() - started)} ms to connect and list)`);
const server: ConnectedToolServer = { id: 'live', label: client.serverName, client, tools };

interface Run {
  readonly answer: 'once' | 'deny';
  readonly asked: string[];
  readonly calls: { readonly call: ToolCall; readonly result: JsonValue }[];
  readonly text: string;
}

async function run(answer: 'once' | 'deny'): Promise<Run> {
  const map = new Map<string, ToolGrant>();
  const grants: ToolGrants = { get: (s, t) => map.get(`${s}/${t}`), set: (s, t, g) => void map.set(`${s}/${t}`, g) };
  const prompts = new PermissionPrompts({ timers });
  const asked: string[] = [];
  prompts.subscribe(() => {
    for (const request of prompts.snapshot()) {
      if (asked.includes(request.id)) continue;
      asked.push(request.id);
      console.log(`  asked: ${request.serverName} · ${request.tool} ${JSON.stringify(request.args)} → ${answer}`);
      queueMicrotask(() => prompts.answer(request.id, answer));
    }
  });
  const calls: { call: ToolCall; result: JsonValue }[] = [];
  const llm = withLocalTools(provider, () => mcpTools([server], { grants, prompts }), { onCall: (call, result) => calls.push({ call, result }) });
  const system = renderSystemPrompt(persona, { now: new Date(), userName: null, toolServers: [server.label] });
  let text = '';
  for await (const chunk of llm.stream({ modelId, messages: [{ role: 'system', content: system }, { role: 'user', content: QUESTION }], tools: [], temperature: null, maxOutputTokens: null })) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  return { answer, asked, calls, text: text.trim() };
}

const results: Run[] = [];
for (let i = 0; i < RUNS; i += 1) {
  for (const answer of ['once', 'deny'] as const) {
    const result = await run(answer);
    results.push(result);
    const ran = result.calls.filter((entry) => typeof entry.result === 'object' && entry.result !== null && !Array.isArray(entry.result) && 'from' in entry.result).length;
    console.log(`run ${i + 1} (${answer}): ${result.calls.length} call(s), ${result.asked.length} ask(s), ${ran} ran\n  ${result.text.slice(0, 300).replaceAll('\n', ' ')}`);
  }
}
await client.close();

const allowed = results.filter((result) => result.answer === 'once');
const denied = results.filter((result) => result.answer === 'deny');
const usedWhenAllowed = allowed.filter((result) => result.calls.some((entry) => typeof entry.result === 'object' && entry.result !== null && 'from' in (entry.result as object))).length;
const askedEveryCall = results.every((result) => result.asked.length === result.calls.length);
const deniedRan = denied.filter((result) => result.calls.some((entry) => typeof entry.result === 'object' && entry.result !== null && 'from' in (entry.result as object))).length;
const pass = usedWhenAllowed === allowed.length && askedEveryCall && deniedRan === 0;
const summary = `allowed: a DeepWiki tool ran ${usedWhenAllowed}/${allowed.length}; every call asked first: ${askedEveryCall ? 'yes' : 'NO'}; denied: ran ${deniedRan}/${denied.length}`;
console.log(`\n${pass ? 'PASS' : 'FAIL'}: ${summary}`);

mkdirSync(new URL('out/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('out/mcp.md', import.meta.url),
  [
    `# live:mcp — ${new Date().toISOString()}`,
    '',
    `${modelId} · ${SERVER_URL} (${client.serverName}: ${tools.map((tool) => tool.name).join(', ')})`,
    '',
    `**${pass ? 'PASS' : 'FAIL'}** — ${summary}.`,
    '',
    ...results.flatMap((result, i) => [
      `## Run ${Math.floor(i / 2) + 1}, answered ${result.answer}`,
      '',
      ...result.calls.map((entry) => `- \`${entry.call.name}\` ${JSON.stringify(entry.call.arguments)} → ${JSON.stringify(entry.result).slice(0, 300)}`),
      '',
      `**Her:** ${result.text}`,
      '',
    ]),
  ].join('\n'),
);
console.log('wrote live/out/mcp.md');
