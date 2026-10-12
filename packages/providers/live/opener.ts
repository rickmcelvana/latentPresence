import { FakeMemoryStore, MemoryKernel, OPENING_CUE, Plans, TagFilter, lastConversation, planTools, renderSystemPrompt, shouldOpen, withLocalTools } from '@latentpresence/core';
import { PersonaSchema, type MemoryEpisode, type PromptContextInput } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live opener check (P6-T02, ADR-51, `pnpm live:opener`): P6-T02's done-when — reopening
 * after a simulated week yields correct phrasing — with a real model, through the real prompt,
 * from a conversation read back out of a store the way `/chat` reads it, asked as `/chat` asks it
 * (no tools for the opener).
 *
 * One conversation (Monday 5 October 2026, evening: a trip to Norway, the dates promised by
 * Friday, a follow-up set for Friday), reopened at five moments. Each of her openers is checked
 * by rule: a greeting that fits the time of day, no word for a gap that is wrong (a week is not
 * "yesterday"), no count of hours, the trip picked up, three sentences at most.
 * `OPENER_RUNS=3` per moment by default. Hand-run, never gated. Writes
 * `docs/runs/P6-T02-openers.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const modelId = env('OPENER_OLLAMA_MODEL') ?? 'glm-5.2:cloud';
const RUNS = Number(env('OPENER_RUNS') ?? '3');

const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 9, day, hour, minute);

const CONVERSATION: [MemoryEpisode['role'], string, Date][] = [
  ['user', 'Can we plan the trip to Norway?', at(5, 19, 30)],
  ['assistant', 'Yes! Fjords or cities first?', at(5, 19, 31)],
  ['user', 'Fjords. I need to sort out the dates with work first.', at(5, 19, 35)],
  ['assistant', 'Fjords it is. When will you know the dates?', at(5, 19, 36)],
  ['user', "I'll know the travel dates by Friday.", at(5, 19, 40)],
  ['assistant', "Sounds great — I'll check in on Friday to see if you have them.", at(5, 19, 41)],
  ['user', 'Night!', at(5, 19, 42)],
];

type Part = 'morning' | 'afternoon' | 'evening' | 'night';

interface Moment {
  readonly name: string;
  readonly now: Date;
  readonly part: Part;
  /** Words for the gap that would be wrong here. */
  readonly wrongGap: RegExp;
  /** What picking up one thing looks like here: the trip, or how it ended. */
  readonly topic: RegExp;
}

const TRIP = /norway|trip|dates?\b|fjord|travel|work/iu;

const MOMENTS: readonly Moment[] = [
  { name: 'a week later, Monday morning (the done-when)', now: at(12, 8, 30), part: 'morning', wrongGap: /yesterday|last night|earlier today|this morning|last time this evening/iu, topic: TRIP },
  // Friday has not come: talking as if it had is wrong, and "Night!" is as good a thing to pick
  // up as the trip ("Sleep okay?").
  { name: 'the next morning', now: at(6, 8, 15), part: 'morning', wrongGap: /a week|weeks|days ago|been a while|long time|ages|did friday|friday go/iu, topic: /sleep|night|norway|trip|dates?\b|fjord|travel/iu },
  // "Night!" was the last word: picking that up is how it ended, as the prompt asks.
  { name: 'later the same evening', now: at(5, 22, 10), part: 'night', wrongGap: /yesterday|last night|a week|days ago|been a while|long time|ages/iu, topic: /night|bed|sleep|back|norway|trip|dates?\b|fjord|travel/iu },
  { name: 'Saturday afternoon, the day after the follow-up', now: at(10, 15, 0), part: 'afternoon', wrongGap: /yesterday|last night|a week ago|weeks|month/iu, topic: TRIP },
  { name: 'a month later, evening', now: at(5 + 31, 19, 0), part: 'evening', wrongGap: /yesterday|last night|last week|a few days/iu, topic: TRIP },
];

const WRONG_GREETING: Record<Part, RegExp> = {
  morning: /good (afternoon|evening)|tonight|this evening/iu,
  afternoon: /good (morning|evening)|tonight/iu,
  evening: /good (morning|afternoon)/iu,
  night: /good (morning|afternoon)/iu,
};

interface Check {
  readonly moment: Moment;
  readonly text: string;
  readonly failures: string[];
  readonly calls: string[];
}

function check(moment: Moment, text: string): string[] {
  const failures: string[] = [];
  const greeting = WRONG_GREETING[moment.part].exec(text);
  if (greeting !== null) failures.push(`greeting "${greeting[0]}" in the ${moment.part}`);
  const gap = moment.wrongGap.exec(text);
  if (gap !== null) failures.push(`gap "${gap[0]}"`);
  const hours = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+hours?\b/iu.exec(text);
  if (hours !== null) failures.push(`a count of hours: "${hours[0]}"`);
  if (!moment.topic.test(text)) failures.push('nothing picked up');
  const sentences = text.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.trim() !== '').length;
  if (sentences > 3) failures.push(`${sentences} sentences`);
  if (text.trim() === '') failures.push('said nothing');
  return failures;
}

async function opener(prompt: string, plans: Plans): Promise<{ text: string; calls: string[] }> {
  const filter = new TagFilter();
  const calls: string[] = [];
  // As `/chat` asks it (ADR-51): the opener has no tools. `TOOLS=1` gives her the plan tools, to
  // see why not — a follow-up cancelled mid-opener made glm say the greeting twice.
  const llm = env('TOOLS') === '1' ? withLocalTools(provider, () => planTools(plans), { onCall: (call) => calls.push(`${call.name} ${JSON.stringify(call.arguments)}`) }) : provider;
  let text = '';
  for await (const chunk of llm.stream({ modelId, messages: [{ role: 'system', content: prompt }, { role: 'user', content: OPENING_CUE }], tools: [], temperature: null, maxOutputTokens: null })) {
    if (chunk.type === 'text-delta') text += filter.push(chunk.text);
  }
  return { text: (text + filter.flush()).replaceAll(/\s+/gu, ' ').trim(), calls };
}

/**
 * Monday's conversation, her plan and the follow-up she set for Friday, as `/chat` would hold them
 * — fresh for every run, because a run may cancel or move the follow-up with her tools.
 */
async function monday(): Promise<{ store: FakeMemoryStore; plans: Plans }> {
  const store = new FakeMemoryStore();
  for (const [index, [role, text, when]] of CONVERSATION.entries()) {
    await store.appendEpisode({ id: `e${index}`, sessionId: 'monday', characterId: 'alice', role, text, interrupted: false, at: when.toISOString(), embedding: null, affect: null });
  }
  const kernel = new MemoryKernel({ store, characterId: 'alice', extractor: null });
  const plans = new Plans({ store, characterId: 'alice', followUps: kernel });
  await plans.load();
  const made = await plans.create({ title: 'Norway trip', goal: 'A fjords trip once the dates are known.', phases: [{ title: 'Dates', tasks: ['Agree travel dates with work'] }] });
  if (!made.ok) throw new Error(made.reason);
  const followed = await plans.followUp('Norway trip', '2026-10-09', 'whether they have the travel dates');
  if (!followed.ok) throw new Error(followed.reason);
  await kernel.idle();
  plans.setFocus(null);
  return { store, plans };
}

const checks: Check[] = [];
const prompts: string[] = [];
for (const moment of MOMENTS) {
  for (let run = 0; run < RUNS; run += 1) {
    const { store, plans } = await monday();
    const since = await lastConversation(store, 'alice', 'now');
    if (!shouldOpen(since, moment.now)) throw new Error(`${moment.name}: she would not open`);
    const context: PromptContextInput = { now: moment.now, since, opening: true, plans: plans.promptContext() };
    const prompt = renderSystemPrompt(persona, context);
    if (run === 0) prompts.push(`### ${moment.name}`, '', '```text', prompt.slice(prompt.indexOf('- Follow-ups')), '```', '');
    const { text, calls } = await opener(prompt, plans);
    const failures = check(moment, text);
    checks.push({ moment, text, failures, calls });
    console.log(`${failures.length === 0 ? 'ok  ' : 'FAIL'} ${moment.name}: ${text}${failures.length === 0 ? '' : `\n     ${failures.join('; ')}`}`);
    if (calls.length > 0) console.log(`     tools: ${calls.join(', ')}`);
  }
}

const passed = checks.filter((entry) => entry.failures.length === 0).length;
const verdict = passed === checks.length ? 'PASS' : 'FAIL';
console.log(`\n${verdict}: ${passed}/${checks.length} openers phrased right (${modelId})`);

const report = [
  '# P6-T02 — openers after time away (`pnpm live:opener`)',
  '',
  `${new Date().toISOString().slice(0, 10)}, ${modelId}, ${RUNS} run(s) per moment. One conversation (Monday 5 October`,
  '2026, 19:30–19:42: a trip to Norway, the dates promised by Friday, a follow-up set for Friday 9',
  'October), read back from a store and reopened at each moment through the real prompt with',
  '`opening: true`. Each opener is checked by rule: a greeting that fits the time of day, no wrong',
  'word for the gap, no count of hours, one thing picked up (the trip, or how it ended), three',
  'sentences at most. Asked as `/chat` asks it, with no tools; each run starts from Monday afresh.',
  '',
  `**${verdict}** — ${passed}/${checks.length}.`,
  '',
  '| Moment | Her opener | Check | Tools |',
  '|---|---|---|---|',
  ...checks.map((entry) => `| ${entry.moment.name} | ${entry.text.replaceAll('|', '\\|')} | ${entry.failures.length === 0 ? 'ok' : entry.failures.join('; ')} | ${entry.calls.map((call) => `\`${call}\``).join('<br>')} |`),
  '',
  '## What she was given (from the follow-ups on)',
  '',
  ...prompts,
];
const out = new URL('../../../docs/runs/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('P6-T02-openers.md', out), `${report.join('\n')}\n`);
console.log('wrote docs/runs/P6-T02-openers.md');
