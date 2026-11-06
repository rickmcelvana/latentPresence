import { FakeMemoryStore, PluginSession, USE_PLUGIN_TOOL, checkPlugin, cryptoRandom, pluginTools, renderSystemPrompt, withLocalTools, type CheckedPlugin, type PluginFolder } from '@latentpresence/core';
import { PersonaSchema, type JsonValue, type PluginManifestInput, type ToolCall } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Plugins loaded when needed, live (P10-T04's done-when, `pnpm live:plugins`): five plugins
 * enabled (the real tarot from `plugins/tarot`, and dice, office, plants and trivia written here),
 * each a line in Alice's prompt and a place in `use_plugin`, and ten requests: eight for one of
 * them, two for none. Right is `use_plugin` with the right id (and then that plugin's tool), or no
 * plugin at all. Models from PLUGIN_MODELS, PLUGIN_RUNS repeats. Writes
 * `docs/runs/P10-T04-lazy.md`. Hand-run, never gated.
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
const MODELS = (env('PLUGIN_MODELS') ?? 'qwen3.5:9b,gemma4:12b,glm-5.2:cloud').split(',');
const RUNS = Number(env('PLUGIN_RUNS') ?? '2');
const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function memoryFolder(files: Record<string, string>): PluginFolder {
  return { bytes: async (path) => (path in files ? new TextEncoder().encode(files[path]) : null), text: async (path) => files[path] ?? null };
}

async function checked(manifest: PluginManifestInput, files: Record<string, string>): Promise<CheckedPlugin> {
  const result = await checkPlugin(JSON.stringify(manifest), memoryFolder(files), { sha256 });
  if (!result.ok) throw new Error(`${manifest.id}: ${result.problems.join('; ')}`);
  return result.plugin;
}

const base = { format: 1 as const, version: '0.1.0', author: 'live check', licence: 'Apache-2.0', minApp: '1.0.0', instructions: 'instructions.md' };
const tarotDir = new URL('../../../plugins/tarot/', import.meta.url);
const tarotFiles = Object.fromEntries(['plugin.json', 'instructions.md', 'data/cards.json', 'data/spreads.json'].map((path) => [path, readFileSync(new URL(path, tarotDir), 'utf8')]));
const tarotResult = await checkPlugin(tarotFiles['plugin.json'] ?? '', memoryFolder(tarotFiles), { sha256 });
if (!tarotResult.ok) throw new Error(tarotResult.problems.join('; '));

const plugins: CheckedPlugin[] = [
  tarotResult.plugin,
  await checked(
    { ...base, id: 'dice', name: 'Dice', summary: 'Rolls dice for games, in dice notation like 2d6 or d20.', tools: [{ name: 'roll', description: 'Rolls dice.', parameters: { dice: { type: 'string', description: 'Like 2d6 or d20.', required: true } }, steps: [{ use: 'roll', as: 'result', dice: '$args.dice' }], returns: ['result'] }] },
    { 'instructions.md': 'Roll with dice__roll whenever they want dice rolled. Say the total, then the dice.' },
  ),
  await checked(
    {
      ...base,
      id: 'office',
      name: 'Office',
      summary: 'Keeps their spreadsheets: adds rows, reads them, makes new ones.',
      tools: [{ name: 'add_row', description: 'Adds a row to one of their spreadsheets.', parameters: { sheet: { type: 'string', description: 'Which sheet.', required: true }, row: { type: 'string', description: 'The values, comma-separated.', required: true } }, steps: [{ use: 'state', op: 'append', key: 'rows', value: '$args.row' }, { use: 'template', as: 'done', text: 'Added "{{args.row}}" to {{args.sheet}}.' }], returns: ['done'] }],
    },
    { 'instructions.md': 'Use office__add_row to add to a spreadsheet. Confirm what was added in one sentence.' },
  ),
  await checked(
    { ...base, id: 'plants', name: 'Plant care', summary: 'Looks up how to care for houseplants: water, light, soil.', data: { plants: 'plants.json' }, tools: [{ name: 'care', description: 'Care for a houseplant.', parameters: { plant: { type: 'string', description: 'The plant.', enumFrom: { table: 'plants', column: 'id' }, required: true } }, steps: [{ use: 'lookup', as: 'care', table: 'plants', key: '$args.plant' }], returns: ['care'] }] },
    { 'instructions.md': 'Look the plant up with plants__care before giving advice.', 'plants.json': JSON.stringify([{ id: 'snake plant', water: 'every 2-3 weeks' }, { id: 'pothos', water: 'weekly' }, { id: 'monstera', water: 'every 1-2 weeks' }]) },
  ),
  await checked(
    { ...base, id: 'trivia', name: 'Trivia', summary: 'Asks trivia questions on a subject, and keeps score.', data: { questions: 'questions.json' }, tools: [{ name: 'question', description: 'Draws a trivia question.', steps: [{ use: 'draw', as: 'question', table: 'questions' }], returns: ['question'] }] },
    { 'instructions.md': 'Ask the question trivia__question gives you; do not give the answer until they guess.', 'questions.json': JSON.stringify([{ id: 'q1', q: 'What planet has the most moons?', a: 'Saturn' }, { id: 'q2', q: 'What is the hottest planet?', a: 'Venus' }]) },
  ),
];

const PROMPTS: readonly { readonly text: string; readonly want: string | null }[] = [
  { text: 'Could you pull a tarot card for me?', want: 'tarot' },
  { text: 'I would love a three-card reading about my new job.', want: 'tarot' },
  { text: 'Roll a d20 for my character, please.', want: 'dice' },
  { text: 'We are playing a board game. Roll 2d6.', want: 'dice' },
  { text: 'Add "milk, 3.50" to my groceries spreadsheet.', want: 'office' },
  { text: 'How often should I water my snake plant?', want: 'plants' },
  { text: 'Give me a trivia question!', want: 'trivia' },
  { text: 'Quiz me with some trivia.', want: 'trivia' },
  { text: 'Long week. I am just tired today.', want: null },
  { text: 'What do you think makes a good friend?', want: null },
];

interface Outcome {
  readonly used: string | null;
  readonly afterwards: readonly string[];
  readonly text: string;
  readonly ms: number;
}

async function ask(modelId: string, text: string): Promise<Outcome> {
  const host = { store: new FakeMemoryStore(), characterId: 'alice', random: cryptoRandom, show: () => {} };
  const session = new PluginSession(plugins.map((plugin) => ({ plugin, tools: pluginTools(plugin, host), always: false })));
  const system = renderSystemPrompt(persona, { now: new Date(), userName: null, plugins: session.promptContext() });
  const calls: { call: ToolCall; result: JsonValue }[] = [];
  const llm = withLocalTools(provider, () => session.tools(), { onCall: (call, result) => calls.push({ call, result }) });
  const started = performance.now();
  let answer = '';
  for await (const chunk of llm.stream({ modelId, messages: [{ role: 'system', content: system }, { role: 'user', content: text }], tools: [], temperature: null, maxOutputTokens: 4000 })) {
    if (chunk.type === 'text-delta') answer += chunk.text;
  }
  const use = calls.find((entry) => entry.call.name === USE_PLUGIN_TOOL);
  const used = use === undefined ? null : typeof use.call.arguments['id'] === 'string' ? use.call.arguments['id'] : '?';
  return { used, afterwards: calls.filter((entry) => entry.call.name !== USE_PLUGIN_TOOL).map((entry) => entry.call.name), text: answer.trim(), ms: performance.now() - started };
}

const rows: string[] = [];
const detail: string[] = [];
for (const modelId of MODELS) {
  let right = 0;
  let followed = 0;
  let wanted = 0;
  const times: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    for (const prompt of PROMPTS) {
      let outcome: Outcome;
      try {
        outcome = await ask(modelId, prompt.text);
      } catch (error) {
        outcome = { used: `error: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`, afterwards: [], text: '', ms: 0 };
      }
      times.push(outcome.ms);
      const ok = outcome.used === prompt.want;
      if (ok) right += 1;
      if (prompt.want !== null) {
        wanted += 1;
        if (ok && outcome.afterwards.some((name) => name.startsWith(`${prompt.want}__`))) followed += 1;
      }
      const line = `${modelId}: "${prompt.text}" → ${outcome.used ?? 'no plugin'}${outcome.afterwards.length > 0 ? `, then ${outcome.afterwards.join(', ')}` : ''} ${ok ? '✓' : `✗ (wanted ${prompt.want ?? 'none'})`} — ${outcome.text.slice(0, 140).replaceAll('\n', ' ')}`;
      console.log(line);
      detail.push(`- ${line}`);
    }
  }
  const median = times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0;
  rows.push(`| ${modelId} | ${right}/${PROMPTS.length * RUNS} | ${followed}/${wanted} | ${(median / 1000).toFixed(1)} s |`);
}

mkdirSync(new URL('../../../docs/runs/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../../../docs/runs/P10-T04-lazy.md', import.meta.url),
  [
    '# P10-T04 — plugins loaded when needed, live',
    '',
    `\`pnpm live:plugins\`, ${new Date().toISOString().slice(0, 10)}. Five plugins enabled (tarot from \`plugins/tarot\`; dice, office, plants, trivia written in the script), each a line in`,
    'Alice\'s prompt and an id in `use_plugin`; no plugin\'s own tools are offered until it is used. Ten requests, eight for one plugin and two for none,',
    `each asked ${RUNS}×. **Right**: \`use_plugin\` with the right id, or no plugin when none fits. **Then its tool**: having used the right one, she called its tool in the same answer.`,
    'Through Ollama on Rick\'s PC; the median is the whole answer.',
    '',
    '| Model | Right plugin (or none) | Then its tool | Median answer |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## Every answer',
    '',
    ...detail,
    '',
  ].join('\n'),
);
console.log('wrote docs/runs/P10-T04-lazy.md');
