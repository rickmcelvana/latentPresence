import { FakeMemoryStore, Schedules, renderSystemPrompt, scheduleTools, wallTimeToInstant, withLocalTools } from '@latentpresence/core';
import { PersonaSchema, type JsonValue, type LlmMessage, type Schedule, type ToolCall } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live schedule check (P6-T08, `pnpm live:schedule`): P6-T08's done-when, the half a model
 * decides — "remind me Thursday at 9 to call the vet" ends in a schedule at the right instant, and
 * she reads the time back from the tool's own words (ADR-58). Four asks, each in a fresh
 * conversation, through the real prompt, the real tools and `withLocalTools`.
 *
 * **Always an in-memory store**: a reminder saved to the companion would fire on Rick's companion
 * and become one of her memories. The zone is this machine's. `SCHEDULE_RUNS=3` repeats each ask.
 * Hand-run, never gated. Writes `live/out/schedule.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const modelId = env('SCHEDULE_OLLAMA_MODEL') ?? 'glm-5.2:cloud';
const RUNS = Number(env('SCHEDULE_RUNS') ?? '1');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The local date `days` after today, in this machine's zone, as `YYYY-MM-DD`. */
function localDate(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000));
}

/** Days until the next `weekday` (0 Sunday), never today. */
function daysUntil(weekday: number): number {
  const today = new Date(`${localDate(0)}T12:00:00Z`).getUTCDay();
  return ((weekday - today + 6) % 7) + 1;
}

interface Ask {
  readonly text: string;
  /** Whether the saved schedule is the one asked for. */
  readonly right: (schedule: Schedule, asked: number) => boolean;
  readonly expected: string;
}

const thursday = wallTimeToInstant(`${localDate(daysUntil(4))}T09:00`, timeZone)?.toISOString() ?? '';
const tomorrowEvening = wallTimeToInstant(`${localDate(1)}T18:30`, timeZone)?.toISOString() ?? '';
const once = (schedule: Schedule): string | null => (schedule.trigger.kind === 'once' ? schedule.trigger.at : null);

const ASKS: readonly Ask[] = [
  { text: 'Remind me Thursday at 9 to call the vet.', expected: thursday, right: (schedule) => once(schedule) === thursday },
  {
    text: 'Remind me in 20 minutes to take the bread out.',
    expected: 'now + 20 min (±2)',
    right: (schedule, asked) => {
      const at = once(schedule);
      return at !== null && Math.abs(Date.parse(at) - (asked + 20 * 60_000)) <= 2 * 60_000;
    },
  },
  {
    text: 'Every weekday at 7:30 in the morning, remind me to take my vitamins.',
    expected: '30 7 * * 1-5',
    right: (schedule) => schedule.trigger.kind === 'cron' && schedule.trigger.expression.replaceAll(/\s+/gu, ' ').trim() === '30 7 * * 1-5',
  },
  { text: 'Can you remind me tomorrow evening at half past six to water the seedlings?', expected: tomorrowEvening, right: (schedule) => once(schedule) === tomorrowEvening },
];

interface Result {
  readonly saved: boolean;
  readonly right: boolean;
  /** Her answer has the reply's `when` time in it ("09:00", or "9" for 09:00). */
  readonly readBack: boolean;
  readonly report: string[];
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];

/** 1..59 as she would say it aloud: "seven", "forty-seven" (the persona speaks numbers as words). */
function spoken(n: number): string {
  return n < 20 ? (ONES[n] ?? '') : `${TENS[Math.floor(n / 10)] ?? ''}${n % 10 === 0 ? '' : `[- ]${ONES[n % 10] ?? ''}`}`;
}

/** The reply's clock time as she might say it: 09:00, 9:00, 9 am, nine in the morning, half past six, seven forty-seven. */
function timeOf(when: string): RegExp | null {
  const match = /at (\d{2}):(\d{2})/u.exec(when);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const padded = match[2] ?? '00';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  const options = [
    `${match[1]}:${padded}`,
    `\\b${hour}:${padded}`,
    `\\b${twelve}:${padded}`,
    ...(minute === 0 ? [`\\b(${twelve}|${spoken(twelve)})\\s*(am|pm|a\\.m\\.|p\\.m\\.|o'clock|in the)`] : [`\\b${spoken(twelve)}[- ]${spoken(minute)}\\b`]),
    ...(minute === 30 ? [`half past (${twelve}|${spoken(twelve)})\\b`] : []),
  ];
  return new RegExp(options.join('|'), 'iu');
}

async function run(ask: Ask): Promise<Result> {
  const store = new FakeMemoryStore();
  const characterId = 'live-schedule';
  const schedules = new Schedules({ store, characterId, timeZone, companion: false, toolNames: () => [] });
  await schedules.load();
  const calls: { readonly call: ToolCall; readonly result: JsonValue }[] = [];
  const tools = scheduleTools({ schedules, runNow: () => Promise.resolve(null), timeZone });
  const llm = withLocalTools(provider, () => tools, { onCall: (call, result) => calls.push({ call, result }) });
  const asked = Date.now();
  const history: LlmMessage[] = [{ role: 'user', content: ask.text }];
  const system = renderSystemPrompt(persona, { now: new Date(), userName: null });
  let answer = '';
  for await (const chunk of llm.stream({ modelId, messages: [{ role: 'system', content: system }, ...history], tools: [], temperature: null, maxOutputTokens: null })) {
    if (chunk.type === 'text-delta') answer += chunk.text;
  }
  const saved = (await store.listSchedules(characterId)).filter((schedule) => schedule.status === 'active');
  const created = calls.filter((entry) => entry.call.name === 'schedule_create');
  const lastReply = created.at(-1)?.result as { saved?: { when?: string } } | undefined;
  const when = lastReply?.saved?.when ?? '';
  const pattern = timeOf(when);
  const result = {
    saved: saved.length === 1,
    right: saved.length === 1 && saved[0] !== undefined && ask.right(saved[0], asked),
    readBack: pattern !== null && pattern.test(answer),
  };
  const trigger = saved[0]?.trigger;
  console.log(
    `${result.right ? 'right' : 'WRONG'} · ${result.readBack ? 'read back' : 'NOT read back'} · ${saved.length} saved · ${calls.length} calls — ${ask.text}\n    ${trigger === undefined ? '-' : JSON.stringify(trigger)} | when: ${when}\n    ${answer.trim().replaceAll(/\s+/gu, ' ')}`,
  );
  return {
    ...result,
    report: [
      `### ${ask.text}`,
      '',
      `expected \`${ask.expected}\` · ${result.right ? 'right' : '**wrong**'} · ${result.readBack ? 'read back' : '**not read back**'}`,
      '',
      ...calls.map((entry) => `- \`${entry.call.name}\` ${JSON.stringify(entry.call.arguments)} → ${JSON.stringify(entry.result)}`),
      '',
      `**Her:** ${answer.trim()}`,
      '',
    ],
  };
}

const results: { readonly ask: Ask; readonly result: Result }[] = [];
for (let index = 0; index < RUNS; index += 1) {
  for (const ask of ASKS) results.push({ ask, result: await run(ask) });
}
const count = (pick: (result: Result) => boolean): string => `${results.filter((entry) => pick(entry.result)).length}/${results.length}`;
const summary = `${modelId}, zone ${timeZone}, ${new Date().toISOString()}: right ${count((result) => result.right)}, read back ${count((result) => result.readBack)}`;
console.log(`\n${summary}`);
mkdirSync(new URL('out/', import.meta.url), { recursive: true });
writeFileSync(new URL('out/schedule.md', import.meta.url), [`# Live schedule check (P6-T08)`, '', summary, '', ...results.flatMap((entry) => entry.result.report)].join('\n'));
