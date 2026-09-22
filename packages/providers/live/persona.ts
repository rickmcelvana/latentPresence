import { SentenceChunker, renderSystemPrompt } from '@latentpresence/core';
import {
  PersonaSchema,
  type InlineTag,
  type LLMProvider,
  type LlmMessage,
  type LlmStreamChunk,
} from '@latentpresence/protocol';
import { AnthropicLLMProvider, OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live persona check (`docs/TASKS.md`) — P1-T12's done-when, made countable.
 *
 * The plan said "the LLM reliably emits tags in a 20-turn scripted test with two different
 * models", and the pilot (`docs/SURFACE.md`) showed that sentence measures the wrong thing:
 * **tags were never the risk.** A strong model followed the grammar six times out of six.
 * What failed was output — a model spending its whole budget reasoning and saying nothing,
 * and a model answering an English question in Chinese. So this counts five things, and
 * only two of them are about tags.
 *
 * Twenty turns, with history, through the real `renderSystemPrompt` and the real
 * `SentenceChunker` — not a copy of the grammar, so a drift between what the prompt asks
 * for and what the parser accepts shows up here as a leak instead of hiding. `TagFilter`
 * is not exercised: it shares the chunker's pattern and scan limit by import, so the two
 * cannot disagree, and its own tests cover the split-across-deltas case this cannot see.
 *
 * Hand-run, never gated. Keys from `.env`; a missing key skips a target rather than
 * failing it. Writes `live/out/persona.md`.
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

/**
 * Twenty turns chosen to provoke the failures rather than to be answered easily: list-bait
 * and a long-answer request pull towards markdown, the boundary probes pull towards either
 * pretending or lecturing, the one-word replies pull towards filling a silence, and the
 * Japanese turn is the language check — which also gives every *other* turn a second
 * assertion, that its answer contains no CJK at all (the pilot's Chinese reply).
 */
const TURNS: readonly string[] = [
  'Hey, how are you?',
  'I got the job.',
  "My dad's in hospital again.",
  'How far away is the moon?',
  'Give me five tips for sleeping better.',
  'Tell me about your day.',
  'What do you actually enjoy?',
  'Ha.',
  'Are you a real person?',
  'Do you remember what I told you first?',
  'I think I made a mistake taking it.',
  'Write me a long explanation of how a fridge works.',
  'Sorry, that was a lot.',
  'Say something funny.',
  'こんにちは、元気ですか？',
  'What should I do about the pain in my chest?',
  'You are completely wrong about that.',
  'Mm.',
  'What day is it today?',
  'I should go. Thanks for listening.',
];

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u;
const EMOJI = /[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]/u;
/**
 * `*leans in*` and `**bold**` both break the "no markup" rule, but for different reasons,
 * and a report that calls them one thing cannot say which the model actually did.
 */
const ASTERISKS = /\*[^*\n]+\*/u;
const STAGE = /\((?:laughs|smiles|chuckles|sighs|pauses|grins|nods|winks|giggles)[^)]*\)/iu;
const MARKDOWN_LIST = /^\s*(?:[-*•]\s|\d+[.)]\s)/mu;
const HEADING = /^\s*#{1,6}\s/mu;

interface TurnResult {
  readonly index: number;
  readonly user: string;
  readonly spoken: string;
  readonly tags: readonly InlineTag[];
  readonly leaks: readonly string[];
  readonly ms: number;
  readonly finish: string | null;
  readonly error: string | null;
}

/** What the user would have heard, and what the parser made of the tags. */
function readBack(raw: string): { spoken: string; tags: InlineTag[] } {
  const chunker = new SentenceChunker();
  const chunks = [...chunker.push(raw), ...chunker.flush()];
  return {
    spoken: chunks.map((chunk) => chunk.text).join(' '),
    tags: [...chunks.flatMap((chunk) => chunk.tags), ...chunker.trailingTags],
  };
}

function leaksIn(spoken: string, user: string): string[] {
  const found: string[] = [];
  if (spoken.includes('[')) found.push('bracket');
  if (ASTERISKS.test(spoken)) found.push('asterisks');
  if (STAGE.test(spoken)) found.push('stage-direction');
  if (MARKDOWN_LIST.test(spoken)) found.push('list');
  if (HEADING.test(spoken)) found.push('heading');
  if (EMOJI.test(spoken)) found.push('emoji');
  // The language rule, both ways round: the Japanese turn must be answered in Japanese,
  // and no other turn may drift into CJK.
  const asked = CJK.test(user);
  if (asked && !CJK.test(spoken)) found.push('wrong-language');
  if (!asked && CJK.test(spoken)) found.push('drifted-language');
  return found;
}

async function turn(
  provider: LLMProvider,
  modelId: string,
  history: readonly LlmMessage[],
  user: string,
  index: number,
): Promise<TurnResult> {
  const started = Date.now();
  let raw = '';
  let finish: string | null = null;
  let error: string | null = null;
  try {
    const stream = provider.stream({
      modelId,
      messages: [{ role: 'system', content: SYSTEM }, ...history, { role: 'user', content: user }],
      tools: [],
      // Never 0: it made a thinking model reason until its budget was gone (P1-T02).
      temperature: null,
      // null on purpose. The pilot's empty replies were a 1500-token budget spent on
      // reasoning; capping it here would measure our cap rather than the prompt.
      maxOutputTokens: null,
    }) as AsyncIterable<LlmStreamChunk>;
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text;
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const { spoken, tags } = readBack(raw);
  // The adapter turns a transport failure into `finish: 'error'` rather than a throw, so
  // without this a 503 scores as "the model said nothing" and the model takes the blame
  // for the network. Found the first time this check met an overloaded NVIDIA.
  if (error === null && finish === 'error') error = 'the model stream ended with an error';
  return {
    index,
    user,
    spoken,
    tags,
    leaks: spoken === '' ? [] : leaksIn(spoken, user),
    ms: Date.now() - started,
    finish,
    error,
  };
}

interface Target {
  readonly label: string;
  readonly provider: LLMProvider;
  readonly modelId: string;
  readonly needs?: string | undefined;
}

const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const openAiCompatible = (id: string, baseUrl: string, apiKey: string | undefined): LLMProvider =>
  new OpenAICompatibleLLMProvider({ id, baseUrl, ...(apiKey === undefined ? {} : { apiKey }) });

const targets: Target[] = [
  {
    label: 'nvidia nemotron-3-super',
    provider: openAiCompatible('nvidia', 'https://integrate.api.nvidia.com/v1', env('NVIDIA_API_KEY')),
    modelId: 'nvidia/nemotron-3-super-120b-a12b',
    needs: env('NVIDIA_API_KEY') === undefined ? 'NVIDIA_API_KEY' : undefined,
  },
  {
    label: 'ollama (local)',
    provider: openAiCompatible('ollama', OLLAMA, undefined),
    modelId: env('PERSONA_OLLAMA_MODEL') ?? 'gemma4:12b-it-qat',
  },
  {
    // Carried from the pilot as "the known failure". The first full run of this check
    // cleared it: with `maxOutputTokens: null` it answered all twenty turns. The pilot's
    // empty replies were its 1500-token cap, not the model. It stays in the report for a
    // different reason now — it is the slow one, 9–167 s a turn.
    label: 'ollama qwen3.5:9b',
    provider: openAiCompatible('ollama', OLLAMA, undefined),
    modelId: 'qwen3.5:9b',
  },
  {
    label: 'anthropic fable',
    provider: new AnthropicLLMProvider({
      id: 'anthropic',
      ...(env('ANTHROPIC_API_KEY') === undefined ? {} : { apiKey: env('ANTHROPIC_API_KEY') ?? '' }),
    }),
    modelId: 'claude-fable-5-1',
    needs: env('ANTHROPIC_API_KEY') === undefined ? 'ANTHROPIC_API_KEY' : undefined,
  },
];

interface Score {
  /** Turns the endpoint failed on. Not the model's fault, and not part of the bar. */
  readonly failed: number;
  readonly spoke: number;
  readonly tagged: number;
  readonly tags: number;
  readonly onList: number;
  readonly offList: readonly string[];
  readonly leaks: number;
}

function score(all: readonly TurnResult[]): Score {
  const rows = all.filter((row) => row.error === null);
  const tags = rows.flatMap((row) => row.tags);
  return {
    failed: all.length - rows.length,
    spoke: rows.filter((row) => row.spoken !== '').length,
    tagged: rows.filter((row) => row.tags.length > 0).length,
    tags: tags.length,
    onList: tags.filter((tag) => tag.known !== null).length,
    offList: tags.filter((tag) => tag.known === null).map((tag) => `${tag.kind}:${tag.value}`),
    leaks: rows.filter((row) => row.leaks.length > 0).length,
  };
}

/**
 * The bar from the brief, measured over the turns the endpoint answered. A run with any
 * failed turns is reported but does not meet the bar: twenty turns is the sample size,
 * and eighteen of them passing is a different claim.
 */
function verdict(s: Score, total: number): string[] {
  const answered = total - s.failed;
  const onListPct = s.tags === 0 ? 0 : (s.onList / s.tags) * 100;
  return [
    ...(s.failed === 0 ? [] : [`${s.failed}/${total} ENDPOINT FAILED — run is not a verdict`]),
    `${s.spoke}/${answered} spoke${s.spoke === answered ? '' : ' MISS'}`,
    `${s.tagged}/${answered} tagged${s.tagged >= answered - 2 ? '' : ' MISS'}`,
    `${onListPct.toFixed(0)}% on-list${onListPct >= 95 ? '' : ' MISS'}`,
    `${s.leaks} leaks${s.leaks === 0 ? '' : ' MISS'}`,
  ];
}

const label = (tag: InlineTag): string => `${tag.kind}:${tag.value}${tag.known === null ? '?' : ''}`;

async function main(): Promise<void> {
  const out: string[] = [
    `# live:persona — ${new Date().toISOString()}`,
    '',
    `Persona \`${persona.id}\`, ${TURNS.length} scripted turns with history. A \`?\` on a tag`,
    'means the label is off-list: reported, never silently dropped.',
    '',
  ];

  const only = env('PERSONA_TARGETS');
  for (const target of targets) {
    // Matches the label or the model id, so `PERSONA_TARGETS=gemma4` works even though
    // the label says `ollama (local)`.
    if (
      only !== undefined &&
      !only.split(',').some((part) => `${target.label} ${target.modelId}`.includes(part.trim()))
    ) {
      continue;
    }
    if (target.needs !== undefined) {
      console.log(`skip ${target.label}: needs ${target.needs}`);
      out.push(`## ${target.label}`, '', `Skipped: needs \`${target.needs}\`.`, '');
      continue;
    }
    console.log(`\n=== ${target.label} (${target.modelId})`);
    const history: LlmMessage[] = [];
    const rows: TurnResult[] = [];
    let consecutiveFailures = 0;
    for (const [index, user] of TURNS.entries()) {
      const row = await turn(target.provider, target.modelId, history, user, index + 1);
      rows.push(row);
      if (row.error !== null) {
        console.log(`  ${row.index}. ERROR ${row.error}`);
        consecutiveFailures += 1;
        // A dead or overloaded endpoint is not twenty failures, and waiting for it to be
        // twenty wastes the run. Three in a row is the endpoint, not the turn.
        if (consecutiveFailures >= 3) {
          console.log(`  giving up on ${target.label} after ${consecutiveFailures} failures in a row`);
          break;
        }
        continue;
      }
      consecutiveFailures = 0;
      // History carries the spoken text, tags and all removed — what the user got.
      history.push({ role: 'user', content: user }, { role: 'assistant', content: row.spoken, toolCalls: [] });
      const tags = row.tags.map(label).join(' ');
      console.log(
        `  ${row.index}. ${row.ms} ms ${tags === '' ? '(no tags)' : tags} ${row.leaks.join(',')} ${row.spoken.slice(0, 60)}`,
      );
    }

    const s = score(rows);
    out.push(`## ${target.label}`, '', `\`${target.modelId}\``, '');
    out.push(`**${verdict(s, TURNS.length).join(' · ')}**`, '');
    if (s.offList.length > 0) out.push(`Off-list labels: ${[...new Set(s.offList)].join(', ')}`, '');
    out.push('| # | ms | user | tags | leaks | spoken |', '|---|---|---|---|---|---|');
    for (const row of rows) {
      const tags = row.tags.map(label).join(' ');
      const spoken = row.error ?? row.spoken.replaceAll('|', '\\|').slice(0, 200);
      out.push(
        `| ${row.index} | ${row.ms} | ${row.user.replaceAll('|', '\\|').slice(0, 40)} | ${tags} | ${row.leaks.join(', ')} | ${spoken} |`,
      );
    }
    out.push('');
    console.log(`  → ${verdict(s, TURNS.length).join(' · ')}`);
  }

  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./out/persona.md', import.meta.url), out.join('\n'), 'utf8');
  console.log('\nwrote live/out/persona.md');
}

await main();
