import { FakeMemoryStore, MemoryKernel, Plans, planToMarkdown, planTools, renderSystemPrompt, withLocalTools } from '@latentpresence/core';
import { PersonaSchema, type LlmMessage, type MemoryStore, type ToolCall, type JsonValue } from '@latentpresence/protocol';
import { CompanionMemoryStore, OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live planning check (P4-T07, `pnpm live:plan`): P4-T07's done-when — "let's plan a
 * vegetable garden" ends with a saved plan — with a real model, through the real prompt, the
 * real tools and `withLocalTools`, into the companion's MariaDB when one is running
 * (`LP_COMPANION_URL`, default `http://127.0.0.1:8787`), else an in-memory store, said so.
 *
 * A character id of its own per run, so nothing lands among Rick's plans. The plan is read
 * back through a **second** store client after the conversation — what MariaDB holds, not what
 * the page believes. `PLAN_RUNS=5` repeats it and counts. Hand-run, never gated. Writes `live/out/plan.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const modelId = env('PLAN_OLLAMA_MODEL') ?? 'glm-5.2:cloud';
const companionUrl = env('LP_COMPANION_URL') ?? 'http://127.0.0.1:8787';

const TURNS: readonly string[] = [
  "Let's plan a vegetable garden.",
  "I've got a sunny patch about two metres by one behind the shed. I want easy things: salad, tomatoes, maybe some beans. I've never grown anything.",
  "That sounds right. Let's go with that, and I'd like to start this weekend by clearing the patch.",
  'Can you check in with me in two weeks to see how the soil prep is going?',
  'I cleared the patch this morning, by the way.',
];

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

const onCompanion = await reachable(companionUrl);
const RUNS = Number(env('PLAN_RUNS') ?? '1');

interface RunResult {
  readonly characterId: string;
  readonly seconds: string;
  /** Exactly one plan, with an outline, read back from the store. */
  readonly saved: boolean;
  /** A `follow_up_on` fact at least ten days out: the fortnight check-in asked for in turn 4. */
  readonly followUp: boolean;
  /** A task marked done after "I cleared the patch" (turn 5). */
  readonly marked: boolean;
  readonly report: string[];
}

async function run(index: number): Promise<RunResult> {
  const store: MemoryStore = onCompanion ? new CompanionMemoryStore({ baseUrl: companionUrl }) : new FakeMemoryStore();
  const characterId = `live-plan-${Date.now().toString(36)}-${index}`;
  const kernel = new MemoryKernel({ store, characterId, extractor: null });
  const plans = new Plans({ store, characterId, followUps: kernel });
  await plans.load();
  const calls: { readonly turn: number; readonly call: ToolCall; readonly result: JsonValue }[] = [];
  let turn = 0;
  const llm = withLocalTools(provider, () => planTools(plans), { onCall: (call, result) => calls.push({ turn, call, result }) });

  const history: LlmMessage[] = [];
  const transcript: string[] = [];
  const started = performance.now();
  for (const [at, text] of TURNS.entries()) {
    turn = at + 1;
    history.push({ role: 'user', content: text });
    const system = renderSystemPrompt(persona, { now: new Date(), userName: null, plans: plans.promptContext() });
    let answer = '';
    for await (const chunk of llm.stream({ modelId, messages: [{ role: 'system', content: system }, ...history], tools: [], temperature: null, maxOutputTokens: null })) {
      if (chunk.type === 'text-delta') answer += chunk.text;
    }
    history.push({ role: 'assistant', content: answer, toolCalls: [] });
    const made = calls.filter((entry) => entry.turn === turn).map((entry) => entry.call.name);
    if (RUNS === 1) console.log(`\n> ${text}\n${answer.trim()}${made.length > 0 ? `\n  [tools: ${made.join(', ')}]` : ''}`);
    transcript.push(`**Rick:** ${text}`, '', `**Her:** ${answer.trim()}`, ...(made.length > 0 ? ['', `_tools: ${made.join(', ')}_`] : []), '');
  }
  await kernel.idle();
  const seconds = ((performance.now() - started) / 1000).toFixed(0);

  // Read back through a second client: what the store holds, not what `plans` believes.
  const reader: MemoryStore = onCompanion ? new CompanionMemoryStore({ baseUrl: companionUrl }) : store;
  const saved = await reader.listPlans(characterId);
  const facts = (await reader.currentFacts(characterId)).filter((fact) => fact.predicate === 'follow_up_on');
  const result = {
    characterId,
    seconds,
    saved: saved.length === 1 && (saved[0]?.phases.length ?? 0) > 0,
    followUp: facts.some((fact) => Date.parse(fact.object.slice(0, 10)) - Date.now() >= 10 * 86_400_000),
    marked: saved.some((plan) => plan.phases.some((phase) => phase.tasks.some((task) => task.status === 'done'))),
  };
  console.log(`run ${index + 1}: plan ${result.saved ? 'saved' : 'MISSING'}, follow-up ${result.followUp ? 'set' : 'not set'}, task ${result.marked ? 'marked' : 'not marked'}, ${calls.length} tool calls (${calls.map((entry) => `${entry.turn}:${entry.call.name}`).join(' ')}), ${seconds} s`);
  return {
    ...result,
    report: [
      `## Run ${index + 1} — \`${characterId}\`, ${seconds} s`,
      '',
      `plan ${result.saved ? 'saved' : '**missing**'} · follow-up ${result.followUp ? 'set' : '**not set**'} · task ${result.marked ? 'marked' : '**not marked**'}`,
      '',
      ...transcript,
      '### Tool calls',
      '',
      ...calls.map((entry) => `- turn ${entry.turn}: \`${entry.call.name}\` ${JSON.stringify(entry.call.arguments)} → ${JSON.stringify(entry.result)}`),
      '',
      '### Read back',
      '',
      ...saved.flatMap((plan) => [`Version ${plan.version}:`, '', '```markdown', planToMarkdown(plan).trimEnd(), '```', '']),
      ...facts.map((fact) => `- fact: \`${fact.subject} ${fact.predicate} ${fact.object}\``),
      '',
    ],
  };
}

const results: RunResult[] = [];
for (let index = 0; index < RUNS; index += 1) results.push(await run(index));
const count = (key: 'saved' | 'followUp' | 'marked'): string => `${results.filter((result) => result[key]).length}/${results.length}`;
const summary = `plan saved ${count('saved')}, follow-up set ${count('followUp')}, task marked ${count('marked')} — in ${onCompanion ? 'MariaDB (companion)' : 'memory (no companion)'}`;
console.log(`\n${results.every((result) => result.saved) ? 'PASS' : 'FAIL'}: ${summary}`);

const report = [
  `# live:plan — ${new Date().toISOString()}`,
  '',
  `${modelId}; store: ${onCompanion ? `companion at ${companionUrl} (MariaDB)` : 'in memory — no companion reachable'}; ${RUNS} run(s).`,
  '',
  `**${results.every((result) => result.saved) ? 'PASS' : 'FAIL'}** — ${summary}.`,
  '',
  ...results.flatMap((result) => result.report),
];
mkdirSync(new URL('out/', import.meta.url), { recursive: true });
writeFileSync(new URL('out/plan.md', import.meta.url), `${report.join('\n')}\n`);
console.log('wrote live/out/plan.md');
