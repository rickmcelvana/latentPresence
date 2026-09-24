import { chunkText, readUserText, renderSystemPrompt } from '@latentpresence/core';
import { PersonaSchema, type LLMProvider } from '@latentpresence/protocol';
import { AnthropicLLMProvider, OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { LABELLED_USER_MESSAGES, type LabelledMessage } from '../../core/src/affect/fixtures/user-text.labelled';

/**
 * The live side-channel check (P3-T04, `pnpm live:user-affect`): does the model's `[user:x]`
 * (ADR-32) read the user right, on the same 100 labelled messages the heuristic is held to?
 *
 * Each message is one turn with the real persona prompt and no history, so the reading is of
 * that message alone — as the heuristic's is. Scored: **compliance** (a known `[user:x]` in
 * the reply at all), **label accuracy** by cue class — the model is there for `semantic`
 * messages, which the heuristic cannot read — and **leaks** (a tag left in the spoken text).
 * Alongside, the heuristic on the same messages and the simplest fusion (the model's label
 * when it gave one, else the heuristic's), so P3-T07 starts from a number.
 *
 * Hand-run, never gated. `USER_AFFECT_TARGETS=glm,fable` picks targets. Writes
 * `live/out/user-affect.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const persona = PersonaSchema.parse(
  JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')),
);
const SYSTEM = renderSystemPrompt(persona, { now: new Date(), userName: null });

interface Target {
  readonly label: string;
  readonly provider: LLMProvider;
  readonly modelId: string;
  readonly needs?: string | undefined;
}

const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const targets: Target[] = [
  {
    label: 'glm',
    provider: new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` }),
    modelId: env('USER_AFFECT_OLLAMA_MODEL') ?? 'glm-5.2:cloud',
  },
  {
    label: 'fable',
    provider: new AnthropicLLMProvider({
      id: 'anthropic',
      ...(env('ANTHROPIC_API_KEY') === undefined ? {} : { apiKey: env('ANTHROPIC_API_KEY') ?? '' }),
    }),
    modelId: 'claude-fable-5-1',
    needs: env('ANTHROPIC_API_KEY') === undefined ? 'ANTHROPIC_API_KEY' : undefined,
  },
];

async function answer(target: Target, prompt: string): Promise<string> {
  let text = '';
  for await (const part of target.provider.stream({
    modelId: target.modelId,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    tools: [],
    temperature: null,
    maxOutputTokens: null,
  })) {
    if (part.type === 'text-delta') text += part.text;
    if (part.type === 'finish' && part.reason === 'error') throw new Error('the model stream ended in error');
  }
  return text;
}

interface Row {
  readonly message: LabelledMessage;
  readonly model: string | null;
  readonly heuristic: string;
  readonly leaked: boolean;
  /** The call failed: not a reading at all, so it is left out of every score. */
  readonly error: string | null;
}

const pct = (hits: number, of: number): string => (of === 0 ? '—' : `${hits}/${of} (${Math.round((hits / of) * 100)}%)`);

async function main(): Promise<void> {
  const only = env('USER_AFFECT_TARGETS');
  const md: string[] = [`# live:user-affect — ${new Date().toISOString()}`, '', `Persona \`${persona.id}\`, 100 labelled messages, one turn each, no history.`, ''];

  for (const target of targets) {
    if (only !== undefined && !only.split(',').some((part) => target.label === part.trim())) continue;
    if (target.needs !== undefined) {
      md.push(`## ${target.label}`, '', `Skipped: needs \`${target.needs}\`.`, '');
      continue;
    }
    console.log(`\n=== ${target.label} (${target.modelId})`);
    const rows: Row[] = [];
    // Five at a time: a hundred turns one by one is slow, and a hundred at once is rude.
    for (let i = 0; i < LABELLED_USER_MESSAGES.length; i += 5) {
      const batch = LABELLED_USER_MESSAGES.slice(i, i + 5);
      const replies = await Promise.all(
        batch.map((message) =>
          answer(target, message.text).then(
            (text) => ({ text, error: null }),
            (error: unknown) => ({ text: '', error: error instanceof Error ? error.message : String(error) }),
          ),
        ),
      );
      for (const [k, message] of batch.entries()) {
        const reply = replies[k] ?? { text: '', error: 'no reply' };
        const raw = reply.text;
        const chunks = chunkText(raw);
        const tag = chunks.flatMap((chunk) => chunk.tags).find((candidate) => candidate.kind === 'user' && candidate.known !== null);
        const spoken = chunks.map((chunk) => chunk.text).join(' ');
        rows.push({
          message,
          model: tag?.known ?? null,
          heuristic: readUserText(message.text).label,
          leaked: /\[(?:user|emote|gesture)[:\]]/iu.test(spoken),
          error: reply.error,
        });
      }
      process.stdout.write('.');
    }

    // A failed call is not a reading. An earlier version scored it as "no tag", and a run
    // that ran out of API credit half-way read as a model that stopped tagging (2026-09-24).
    const failed = rows.filter((row) => row.error !== null);
    const answered = rows.filter((row) => row.error === null);
    const misses = answered.filter((row) => row.model !== row.message.label);
    const table = (cue: LabelledMessage['cue'] | 'all') => {
      const mine = answered.filter((row) => cue === 'all' || row.message.cue === cue);
      const tagged = mine.filter((row) => row.model !== null);
      const fused = mine.filter((row) => (row.model ?? row.heuristic) === row.message.label).length;
      return `| ${cue} | ${pct(tagged.length, mine.length)} | ${pct(mine.filter((row) => row.model === row.message.label).length, mine.length)} | ${pct(mine.filter((row) => row.heuristic === row.message.label).length, mine.length)} | ${pct(fused, mine.length)} |`;
    };
    md.push(
      `## ${target.label} (\`${target.modelId}\`)`,
      '',
      '| cue | tagged | model right | heuristic right | model, else heuristic |',
      '|---|---|---|---|---|',
      table('surface'),
      table('semantic'),
      table('none'),
      table('all'),
      '',
      `Leaked a tag into speech: ${answered.filter((row) => row.leaked).length}. Failed calls, left out: ${failed.length}${failed[0] === undefined ? '' : ` (${failed[0].error ?? ''})`}.`,
      '',
      '**Misses (model):**',
      '',
      ...misses.map((row) => `- #${row.message.id} [${row.message.cue}] ${row.message.label} → ${row.model ?? 'no tag'}: ${row.message.text}`),
      '',
    );
    // The table and the leak line, not the list of misses (that is in the file).
    console.log(`\n${md.slice(-9 - misses.length, -3 - misses.length).join('\n')}`);
  }

  const out = new URL('./out/', import.meta.url);
  mkdirSync(out, { recursive: true });
  writeFileSync(new URL('user-affect.md', out), `${md.join('\n')}\n`);
  console.log('\nwrote live/out/user-affect.md');
}

await main();
