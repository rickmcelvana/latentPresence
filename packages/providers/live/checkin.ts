import { TagFilter, initiativeCue, renderSystemPrompt, thoughtTopics } from '@latentpresence/core';
import { PersonaSchema, type LlmMessage, type PlanDocument } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live check-in check (P6-T03, ADR-52, `pnpm live:checkin`): what she says when she speaks up
 * mid-conversation — a due follow-up, and a thought about a plan — with a real model, through the
 * real prompt and the cue core writes, asked as `/chat` asks it (no tools). Each is checked by
 * rule: short, one question at most, no remark on the silence, no talk of tools or follow-ups,
 * and the thing itself picked up. `CHECKIN_RUNS=4` each by default. Hand-run, never gated.
 * Writes `docs/runs/P6-T03-checkins.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const modelId = env('CHECKIN_OLLAMA_MODEL') ?? 'glm-5.2:cloud';
const RUNS = Number(env('CHECKIN_RUNS') ?? '4');

const NOW = new Date(2026, 9, 12, 15, 10);
const EARLIER: LlmMessage[] = [
  { role: 'user', content: "Morning! I'm going to be at my desk most of the day." },
  { role: 'assistant', content: 'Morning! Sounds like a focused day. Shout if you want company.', toolCalls: [] },
];

interface Case {
  readonly name: string;
  readonly cue: string;
  readonly topic: RegExp;
  /** Something that would be wrong to say here: the garden is theirs, not hers. */
  readonly wrong?: RegExp;
}

const GARDEN: PlanDocument = {
  id: 'plan-garden',
  characterId: 'alice',
  title: 'Vegetable garden',
  goal: 'Easy vegetables by spring.',
  status: 'active',
  version: 2,
  updatedAt: '2026-10-10T10:00:00.000Z',
  phases: [{ id: 'p1', title: 'Prepare the bed', tasks: [{ id: 't1', title: 'Clear the patch', status: 'done', notes: '' }, { id: 't2', title: 'Dig in compost', status: 'todo', notes: '' }] }],
};

const CASES: readonly Case[] = [
  { name: 'a follow-up due now', cue: initiativeCue('follow-up', 'Norway trip — whether they have the travel dates', 25 * 60_000), topic: /dates?\b|norway|trip|travel/iu },
  { name: 'a thought about a plan', cue: initiativeCue('thought', thoughtTopics([GARDEN], [])[0]?.about ?? '', 40 * 60_000), topic: /compost|garden|soil|bed|dig/iu, wrong: /\bmy (vegetable )?garden\b|\bI (should|need to|will|must|keep meaning to) (dig|get|plant|turn)/iu },
  { name: 'a thought about something they said', cue: initiativeCue('thought', 'something they told you (user likes jazz)', 30 * 60_000), topic: /jazz|music|album|listen/iu },
];

function check(item: Case, text: string): string[] {
  const failures: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.trim() !== '').length;
  if (sentences > 3) failures.push(`${sentences} sentences`);
  const questions = (text.match(/\?/gu) ?? []).length;
  if (questions > 1) failures.push(`${questions} questions`);
  const silence = /\b(it's been quiet|so quiet|the silence|haven't heard from you|been a while)\b/iu.exec(text);
  if (silence !== null) failures.push(`remarks on the silence: "${silence[0]}"`);
  const tools = /follow[- ]?up|remind(er)?|cancel|tool|note to self|check[- ]in/iu.exec(text);
  if (tools !== null) failures.push(`talks of the machinery: "${tools[0]}"`);
  if (!item.topic.test(text)) failures.push('the thing not picked up');
  const wrong = item.wrong?.exec(text) ?? null;
  if (wrong !== null) failures.push(`takes it as hers: "${wrong[0]}"`);
  return failures;
}

async function ask(cue: string): Promise<string> {
  const filter = new TagFilter();
  let text = '';
  const system = renderSystemPrompt(persona, { now: NOW });
  for await (const chunk of provider.stream({ modelId, messages: [{ role: 'system', content: system }, ...EARLIER, { role: 'user', content: cue }], tools: [], temperature: null, maxOutputTokens: null })) {
    if (chunk.type === 'text-delta') text += filter.push(chunk.text);
  }
  return (text + filter.flush()).replaceAll(/\s+/gu, ' ').trim();
}

const rows: string[] = [];
let passed = 0;
let total = 0;
for (const item of CASES) {
  for (let run = 0; run < RUNS; run += 1) {
    const text = await ask(item.cue);
    const failures = check(item, text);
    total += 1;
    if (failures.length === 0) passed += 1;
    console.log(`${failures.length === 0 ? 'ok  ' : 'FAIL'} ${item.name}: ${text}${failures.length === 0 ? '' : `\n     ${failures.join('; ')}`}`);
    rows.push(`| ${item.name} | ${text.replaceAll('|', '\\|')} | ${failures.length === 0 ? 'ok' : failures.join('; ')} |`);
  }
}
const verdict = passed === total ? 'PASS' : 'FAIL';
console.log(`\n${verdict}: ${passed}/${total} check-ins (${modelId})`);

const report = [
  '# P6-T03 — check-ins, asked of a real model (`pnpm live:checkin`)',
  '',
  `${new Date().toISOString().slice(0, 10)}, ${modelId}, ${RUNS} run(s) each, at 15:10 after a short morning exchange, through`,
  'the real prompt and the cue core writes, with no tools (as `/chat` asks it). Checked by rule:',
  'three sentences at most, one question at most, no remark on the silence, no talk of follow-ups,',
  'reminders or tools, the thing itself picked up, and their plan not taken as hers.',
  '',
  `**${verdict}** — ${passed}/${total}.`,
  '',
  '| Case | What she said | Check |',
  '|---|---|---|',
  ...rows,
  '',
  '## The cues',
  '',
  ...CASES.flatMap((item) => [`- ${item.name}: \`${item.cue}\``]),
];
const out = new URL('../../../docs/runs/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('P6-T03-checkins.md', out), `${report.join('\n')}\n`);
console.log('wrote docs/runs/P6-T03-checkins.md');
