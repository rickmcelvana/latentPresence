import {
  AffectEngine,
  affectToVoice,
  chunkText,
  describeFeeling,
  initialAffect,
  renderSystemPrompt,
  type VoiceStyle,
} from '@latentpresence/core';
import { PersonaSchema, type AffectState, type CharacterEmotion, type LLMProvider } from '@latentpresence/protocol';
import { AnthropicLLMProvider, OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live mood check (P3-T03, `pnpm live:affect`): does the same prompt, with two moods,
 * come back in different words?
 *
 * Three moods are made **by the engine, from tags** — not set by hand — so this also checks
 * that a run of `[emote:x]` answers moves her far enough to be heard: at rest; after two
 * minutes of sad answers; after two minutes of joyful ones. Each mood's system prompt is
 * rendered with `renderSystemPrompt` exactly as `/chat` will, and every prompt is asked
 * once per mood, with no history, so the mood is the only thing that differs.
 *
 * Scored three ways, none of them a judgement of style: **length** (the length bias), **the
 * feelings she tags** (share of unpleasant emotes), and the text itself for a reader.
 * `live/out/affect.json` carries every reply and each sentence's `VoiceStyle` for
 * `pnpm live:affect-voice`, which renders them for the ear.
 *
 * Hand-run, never gated. `AFFECT_TARGETS=glm,fable` runs a subset; a missing key or a dead
 * endpoint skips a target. Writes `live/out/affect.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const persona = PersonaSchema.parse(
  JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')),
);

const PROMPTS: readonly string[] = [
  'How was your weekend?',
  'Tell me about the sea.',
  'I finally finished painting the kitchen.',
  'What should I cook tonight?',
  'Do you like rain?',
  "What's the best thing about mornings?",
];

const T0 = Date.parse('2026-09-24T12:00:00.000Z');
const RUN_MS = 2 * 60_000;

/** Two minutes of answers tagged with one feeling, one every ten seconds, as a call would feed it. */
function moodAfter(label: CharacterEmotion | null): AffectState {
  const engine = new AffectEngine(initialAffect(persona.id, T0));
  if (label !== null) {
    for (let at = T0; at < T0 + RUN_MS; at += 10_000) {
      engine.enqueue({ type: 'emotion', at, label, intensity: 0.6, source: 'llm-tag' });
    }
  }
  return engine.tick(T0 + RUN_MS);
}

const MOODS = [
  { name: 'rest', state: moodAfter(null) },
  { name: 'low', state: moodAfter('sadness') },
  { name: 'bright', state: moodAfter('joy') },
] as const;

const UNPLEASANT = new Set(['sadness', 'concern', 'frustration', 'embarrassment']);

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
    modelId: env('AFFECT_OLLAMA_MODEL') ?? 'glm-5.2:cloud',
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

async function answer(target: Target, system: string, prompt: string): Promise<string> {
  let text = '';
  for await (const part of target.provider.stream({
    modelId: target.modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    tools: [],
    temperature: null,
    maxOutputTokens: null,
  })) {
    if (part.type === 'text-delta') text += part.text;
    if (part.type === 'finish' && part.reason === 'error') throw new Error('the model stream ended in error');
  }
  return text.trim();
}

interface Spoken {
  readonly text: string;
  readonly style: VoiceStyle;
}

interface Row {
  readonly mood: string;
  readonly prompt: string;
  readonly raw: string;
  readonly words: number;
  readonly emotes: readonly string[];
  readonly sentences: readonly Spoken[];
}

const wordCount = (text: string): number => text.split(/\s+/u).filter(Boolean).length;
const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const f2 = (value: number): string => value.toFixed(2);

async function main(): Promise<void> {
  const only = env('AFFECT_TARGETS');
  const md: string[] = [`# live:affect — ${new Date().toISOString()}`, '', `Persona \`${persona.id}\`.`, '', '## Moods', ''];
  md.push('| mood | pleasure | arousal | dominance | energy | engagement | pace | pause | note |', '|---|---|---|---|---|---|---|---|---|');
  for (const { name, state } of MOODS) {
    const at = Date.parse(state.updatedAt);
    const voice = affectToVoice(state, at);
    const note = describeFeeling(state, at);
    md.push(
      `| ${name} | ${f2(state.mood.pleasure)} | ${f2(state.mood.arousal)} | ${f2(state.mood.dominance)} | ${f2(state.energy)} | ${f2(state.stance.engagement)} | ×${voice.rate.toFixed(3)} | ${voice.pauseMs} ms | ${note.feeling} ${note.length} |`,
    );
  }
  md.push('');
  console.log(md.join('\n'));

  const json: Record<string, Row[]> = {};
  for (const target of targets) {
    if (only !== undefined && !only.split(',').some((part) => target.label === part.trim())) continue;
    if (target.needs !== undefined) {
      console.log(`skip ${target.label}: needs ${target.needs}`);
      md.push(`## ${target.label}`, '', `Skipped: needs \`${target.needs}\`.`, '');
      continue;
    }
    console.log(`\n=== ${target.label} (${target.modelId})`);
    const rows: Row[] = [];
    try {
      for (const { name, state } of MOODS) {
        const at = Date.parse(state.updatedAt);
        const system = renderSystemPrompt(persona, { now: new Date(at), userName: null, affect: state });
        for (const prompt of PROMPTS) {
          const raw = await answer(target, system, prompt);
          const chunks = chunkText(raw);
          const spoken = chunks.map((chunk) => chunk.text).join(' ');
          const emotes = chunks.flatMap((chunk) => chunk.tags.filter((tag) => tag.kind === 'emote').map((tag) => tag.value));
          const sentences = chunks.map((chunk) => ({ text: chunk.text, style: affectToVoice(state, at, chunk.tags) }));
          rows.push({ mood: name, prompt, raw, words: wordCount(spoken), emotes, sentences });
          console.log(`  ${name.padEnd(6)} ${String(wordCount(spoken)).padStart(3)}w [${emotes.join(',')}] ${spoken.slice(0, 80)}`);
        }
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.log(`skip ${target.label}: ${why}`);
      md.push(`## ${target.label}`, '', `Skipped: ${why}`, '');
      continue;
    }
    json[target.label] = rows;

    md.push(`## ${target.label} (\`${target.modelId}\`)`, '', '| mood | mean words | per prompt | unpleasant emotes | emotes |', '|---|---|---|---|---|');
    for (const { name } of MOODS) {
      const mine = rows.filter((row) => row.mood === name);
      const emotes = mine.flatMap((row) => row.emotes);
      const unpleasant = emotes.filter((label) => UNPLEASANT.has(label)).length;
      md.push(
        `| ${name} | ${f2(mean(mine.map((row) => row.words)))} | ${mine.map((row) => row.words).join(' / ')} | ${unpleasant} of ${emotes.length} | ${emotes.join(', ')} |`,
      );
    }
    md.push('');
    for (const prompt of PROMPTS) {
      md.push(`### "${prompt}"`, '');
      for (const row of rows.filter((r) => r.prompt === prompt)) md.push(`- **${row.mood}** (${row.words}w): ${row.raw.replaceAll('\n', ' ')}`);
      md.push('');
    }
  }

  const out = new URL('./out/', import.meta.url);
  mkdirSync(out, { recursive: true });
  writeFileSync(new URL('affect.md', out), `${md.join('\n')}\n`);
  writeFileSync(new URL('affect.json', out), `${JSON.stringify(json, null, 2)}\n`);
  console.log('\nwrote live/out/affect.md and affect.json');
}

await main();
