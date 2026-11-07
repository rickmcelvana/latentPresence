import { PermissionPrompts, PluginSession, checkPlugin, mcpTools, renderSystemPrompt, withLocalTools, type LocalTool, type ToolGrant, type ToolGrants } from '@latentpresence/core';
import { PersonaSchema, type ChatMessage, type JsonValue, type ToolCall } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { companionToolServers } from '@latentpresence/providers/web';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Office, live (P10-T08's done-when, `pnpm live:office`): Alice with the real `plugins/office`
 * loaded directly and a running companion's Files tools (start it on an `mcp.json` with a folder in
 * `files.write`; COMPANION_URL, default http://127.0.0.1:8799). Each ask goes through the same
 * permission gate as the app; every ask is answered "once" here and counted. Three turns of one
 * conversation, as said aloud: a grocery budget spreadsheet, a drafted letter, and an edit to it.
 * Each turn is **right** when the tool it needs was asked about, ran, and the file read back has
 * what was asked. Models from OFFICE_MODELS. Writes `docs/runs/P10-T08-office.md`. Hand-run, never gated.
 */

try {
  process.loadEnvFile('../../.env');
} catch {
  // No .env: nothing here needs one.
}
const env = (name: string): string | undefined => (process.env[name] === undefined || process.env[name] === '' ? undefined : process.env[name]);
const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const MODELS = (env('OFFICE_MODELS') ?? 'glm-5.2:cloud,gemma4:12b,qwen3.5:9b').split(',');
const COMPANION = env('COMPANION_URL') ?? 'http://127.0.0.1:8799';

const dir = new URL('../../../plugins/office/', import.meta.url);
const files = Object.fromEntries(['plugin.json', 'instructions.md'].map((path) => [path, readFileSync(new URL(path, dir), 'utf8')]));
const checked = await checkPlugin(files['plugin.json'] ?? '', { bytes: async (path) => (path in files ? new TextEncoder().encode(files[path]) : null), text: async (path) => files[path] ?? null }, { sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex') });
if (!checked.ok) throw new Error(checked.problems.join('; '));
const plugin = checked.plugin;

class NoGrants implements ToolGrants {
  get(): ToolGrant | undefined {
    return undefined;
  }
  set(): void {}
}

async function companionTools(prompts: PermissionPrompts): Promise<LocalTool[]> {
  const servers = await companionToolServers({ baseUrl: COMPANION });
  const server = servers.find((entry) => entry.server.id === 'files');
  if (server?.client == null) throw new Error(`the companion at ${COMPANION} has no Files server ready`);
  if (!server.tools.some((tool) => tool.name === 'write_spreadsheet')) throw new Error('no Files folder is open for writing (files.write in mcp.json)');
  return mcpTools([{ id: 'companion:files', label: server.server.label, client: server.client, tools: server.tools }], { grants: new NoGrants(), prompts });
}

/** Reads a file back through the companion itself, as she would. */
async function readBack(tool: 'read_spreadsheet' | 'read_document', path: string): Promise<string> {
  const response = await fetch(`${COMPANION}/mcp/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: randomUUID(), serverId: 'files', name: tool, arguments: { path } }) });
  const body = (await response.json()) as { text?: string; isError?: boolean };
  return body.isError === true ? `(error) ${body.text ?? ''}` : (body.text ?? '');
}

interface Turn {
  readonly say: string;
  readonly tool: string;
  /** What the file read back must show for the turn to be right. */
  readonly check: (readBack: string, call: ToolCall | undefined) => string | null;
}

const MONTH = new Date().toLocaleString('en-CA', { month: 'long' });
const TURNS: readonly Turn[] = [
  {
    say: "Make a spreadsheet of this month's grocery budget.",
    tool: 'files__write_spreadsheet',
    check: (text) => (text.split('\n').filter((line) => /^A\d+: /u.test(line)).length < 4 ? 'fewer than three items' : null),
  },
  {
    say: "Now draft a short letter to my landlord, Mr. Okafor, saying the kitchen tap has been dripping for a week and asking if someone can fix it on Thursday. Sign it from Rick.",
    tool: 'files__write_document',
    check: (text) => (!/Okafor/u.test(text) ? 'no Okafor' : !/Thursday/u.test(text) ? 'no Thursday' : !/Rick/u.test(text) ? 'not signed' : null),
  },
  {
    say: 'Change Thursday to Friday morning in that letter.',
    tool: 'files__edit_document',
    check: (text) => (/Thursday/u.test(text) ? 'still says Thursday' : !/Friday/u.test(text) ? 'no Friday' : null),
  },
];

interface TurnOutcome {
  readonly right: boolean;
  readonly why: string;
  readonly asks: number;
  readonly calls: readonly string[];
  readonly path: string | null;
  readonly text: string;
  readonly ms: number;
  /** The spreadsheet totals with a formula, as the instructions ask. */
  readonly formulas: boolean;
}

async function conversation(modelId: string): Promise<TurnOutcome[]> {
  const prompts = new PermissionPrompts({ timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) } });
  let asks = 0;
  // The person says "once" to every ask, as they would at the ask card.
  prompts.subscribe(() => {
    for (const request of prompts.snapshot()) {
      asks += 1;
      prompts.answer(request.id, 'once');
    }
  });
  const tools = await companionTools(prompts);
  const session = new PluginSession([{ plugin, tools: [], always: true }]);
  const system = renderSystemPrompt(persona, { now: new Date(), userName: 'Rick', plugins: session.promptContext() });
  const history: ChatMessage[] = [{ role: 'system', content: system }];
  const outcomes: TurnOutcome[] = [];
  let lastPath: Record<string, string> = {};
  for (const turn of TURNS) {
    const calls: { call: ToolCall; result: JsonValue }[] = [];
    const llm = withLocalTools(provider, () => tools, { onCall: (call, result) => calls.push({ call, result }) });
    const before = asks;
    const started = performance.now();
    let answer = '';
    history.push({ role: 'user', content: turn.say });
    try {
      for await (const chunk of llm.stream({ modelId, messages: history, tools: [], temperature: null, maxOutputTokens: 8000 })) {
        if (chunk.type === 'text-delta') answer += chunk.text;
      }
    } catch (error) {
      answer = `(error) ${error instanceof Error ? error.message : String(error)}`;
    }
    // ConversationHistory keeps her words only (as in the app).
    history.push({ role: 'assistant', content: answer, toolCalls: [] });
    // A refusal comes back as `{ error }` (the gate's or the companion's own words).
    const writes = calls.filter((entry) => entry.call.name === turn.tool && !(entry.result !== null && typeof entry.result === 'object' && !Array.isArray(entry.result) && 'error' in entry.result));
    const call = writes.at(-1)?.call;
    const given = typeof call?.arguments['path'] === 'string' ? (call.arguments['path'] as string) : null;
    const kind = turn.tool === 'files__write_spreadsheet' ? 'xlsx' : 'docx';
    if (given !== null) lastPath = { ...lastPath, [kind]: given };
    const path = given ?? lastPath[kind] ?? null;
    const back = path === null ? '' : await readBack(kind === 'xlsx' ? 'read_spreadsheet' : 'read_document', `Office/${path.split(/[\\/]/u).at(-1) ?? path}`);
    const problem = call === undefined ? `no successful ${turn.tool}` : back.startsWith('(error)') ? back.slice(0, 120) : turn.check(back, call);
    outcomes.push({ right: problem === null, why: problem ?? '✓', asks: asks - before, calls: calls.map((entry) => entry.call.name), path, text: answer.trim(), ms: performance.now() - started, formulas: /=SUM\(/u.test(back) });
    const line = `${modelId}: "${turn.say}" → ${problem === null ? '✓' : `✗ ${problem}`} · ${calls.map((entry) => entry.call.name).join(', ') || 'no tools'} · ${asks - before} ask(s) · ${((performance.now() - started) / 1000).toFixed(1)} s — ${answer.trim().slice(0, 160).replaceAll('\n', ' ')}`;
    console.log(line);
    for (const entry of calls) {
      const result = entry.result as { error?: string } | null;
      if (result !== null && typeof result === 'object' && 'error' in result) console.log(`    ${entry.call.name}(${JSON.stringify(entry.call.arguments).slice(0, 300)}) → ${String(result.error).slice(0, 300)}`);
    }
    if (process.env['OFFICE_SHOW'] === '1' && back !== '') console.log(back.split('\n').slice(0, 14).map((row) => `    ${row}`).join('\n'));
  }
  return outcomes;
}

const rows: string[] = [];
const detail: string[] = [];
/** OFFICE_CLEAR: the open folder, emptied before each model, so one model's file never blocks the next's name. */
const CLEAR = env('OFFICE_CLEAR');
for (const modelId of MODELS) {
  if (CLEAR !== undefined) for (const name of readdirSync(CLEAR)) if (/\.(xlsx|docx)$/iu.test(name)) rmSync(join(CLEAR, name));
  let outcomes: TurnOutcome[];
  try {
    outcomes = await conversation(modelId);
  } catch (error) {
    console.log(`${modelId}: ${error instanceof Error ? error.message : String(error)}`);
    rows.push(`| ${modelId} | error | | | | |`);
    continue;
  }
  rows.push(`| ${modelId} | ${outcomes.map((outcome) => (outcome.right ? '✓' : `✗ ${outcome.why}`)).join(' | ')} | ${outcomes[0]?.formulas === true ? 'yes' : 'no'} | ${outcomes.reduce((sum, outcome) => sum + outcome.asks, 0)} |`);
  outcomes.forEach((outcome, index) => detail.push(`- ${modelId}, "${TURNS[index]?.say ?? ''}": ${outcome.right ? '✓' : `✗ ${outcome.why}`}; tools ${outcome.calls.join(', ') || 'none'}; ${outcome.asks} ask(s); ${(outcome.ms / 1000).toFixed(1)} s; file ${outcome.path ?? '—'} — ${outcome.text.slice(0, 220).replaceAll('\n', ' ')}`));
}

mkdirSync(new URL('../../../docs/runs/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../../../docs/runs/P10-T08-office.md', import.meta.url),
  [
    '# P10-T08 — Office, live',
    '',
    `\`pnpm live:office\`, ${new Date().toISOString().slice(0, 10)} (${MONTH}). Alice with \`plugins/office\` ${String(plugin.manifest.version)} loaded directly and a real companion's Files tools,`,
    'one folder open for writing. One conversation a model, three turns as said aloud. Every write went through the permission gate and was answered "once".',
    '**Right**: the tool ran without a refusal and the file, read back through the companion, has what was asked (at least three items; the',
    'landlord, Thursday and the signature; then Friday and no Thursday). Through Ollama on Rick\'s PC.',
    '',
    '| Model | Grocery budget (.xlsx) | Letter (.docx) | Edit by voice | Totals by formula | Asks |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Every turn',
    '',
    ...detail,
    '',
  ].join('\n'),
);
console.log('wrote docs/runs/P10-T08-office.md');
