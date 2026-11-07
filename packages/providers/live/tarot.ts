import { FakeMemoryStore, PluginSession, checkPlugin, cryptoRandom, pluginTools, renderSystemPrompt, withLocalTools, type PluginDisplay, type PluginFolder, type PluginRow } from '@latentpresence/core';
import { PersonaSchema, type JsonValue, type ToolCall } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Tarot, live (P10-T06's done-when, `pnpm live:tarot`): Alice with the real `plugins/tarot` loaded
 * directly (ADR-72 item 4 as amended), asked to read their cards. A run is **right** when she draws
 * with the tool, the spread reaches the wall, and her answer names every card drawn and no card that
 * was not. Also counted: whether she drew three (the instructions' default), and whether each
 * reversed card is said to be reversed. Models from TAROT_MODELS, TAROT_RUNS each. Writes
 * `docs/runs/P10-T06-tarot.md`. Hand-run, never gated.
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
const MODELS = (env('TAROT_MODELS') ?? 'glm-5.2:cloud,gemma4:12b,qwen3.5:9b').split(',');
const RUNS = Number(env('TAROT_RUNS') ?? '10');

const dir = new URL('../../../plugins/tarot/', import.meta.url);
const files = Object.fromEntries(['plugin.json', 'instructions.md', 'data/cards.json', 'data/spreads.json'].map((path) => [path, readFileSync(new URL(path, dir), 'utf8')]));
const folder: PluginFolder = { bytes: async (path) => (path in files ? new TextEncoder().encode(files[path]) : null), text: async (path) => files[path] ?? null };
const checked = await checkPlugin(files['plugin.json'] ?? '', folder, { sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex') });
if (!checked.ok) throw new Error(checked.problems.join('; '));
const plugin = checked.plugin;
const deck = (plugin.data['cards'] ?? []).map((card) => String(card['name']));

/**
 * TAROT_CASE=later: the request comes after an earlier reading and a chat about something else, as in
 * a long call (R-68, 2026-11-06: glm-5.2 read three cards that never reached the wall). The history is
 * what `ConversationHistory` keeps: her words only, so the earlier reading shows no tool call.
 */
const CASE = env('TAROT_CASE') ?? 'fresh';
const EARLIER_CARDS = ['The Star', 'Five of Cups', 'Knight of Wands', 'The Hermit', 'Three of Pentacles', 'The Moon', 'Queen of Swords', 'Six of Wands', 'Ace of Cups', 'The World'];
const EARLIER: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[] = [
  { role: 'user', content: 'Could you lay out a Celtic cross for me?' },
  {
    role: 'assistant',
    content:
      "Here's your Celtic cross. At the heart of it is The Star: hope coming back after a hard stretch. Crossing it, the Five of Cups, reversed, so you're starting to move on from a loss. " +
      'Crowning it, the Knight of Wands: bold energy ahead. Beneath, The Hermit: you have done a lot of thinking alone. Behind you, the Three of Pentacles; ahead, The Moon, so not everything is clear yet. ' +
      'Yourself is the Queen of Swords, your surroundings the Six of Wands, your hopes and fears the Ace of Cups, and the outcome The World. A cycle completing. How does that sit with you?',
  },
  { role: 'user', content: 'That sits pretty well, actually. Anyway, I spent the afternoon fixing the fence in the back yard.' },
  { role: 'assistant', content: 'Oh, how did it go? Was it the old section by the gate that kept leaning?' },
  { role: 'user', content: 'Yes, that one. Two new posts, and I finally got it straight. My hands are sore though.' },
  { role: 'assistant', content: 'That sounds like a satisfying kind of sore. Two posts is real work. Did you set them in concrete?' },
  { role: 'user', content: 'Gravel and concrete, yes. Then I made chili for dinner and watched a movie.' },
  { role: 'assistant', content: 'A good day, then: built something, cooked something, and rested. What did you watch?' },
];
const LATER_PROMPTS = ['Could you do one more reading for me? A three-card spread this time.', 'Read my cards one more time, please, three cards.', 'One more reading before bed? Just three cards.'];

const PROMPTS = ['Read my cards.', 'Would you read my cards? I start a new job on Monday.', 'Can you read my cards for the week ahead?', 'Read my cards, please.', "I'd love it if you'd read my cards tonight."];

/** A card named as models write names: "The"/"the" either way, the rest as printed ("Strength", not "strength"). */
function named(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/^The /u, '[Tt]he ');
  return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, 'u').test(text);
}

interface Outcome {
  readonly drawn: readonly PluginRow[];
  readonly spread: string | null;
  readonly shown: boolean;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly reversedSaid: number;
  readonly reversedDrawn: number;
  readonly text: string;
  readonly ms: number;
}

async function ask(modelId: string, text: string, earlier: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[] = []): Promise<Outcome> {
  const shown: PluginDisplay[] = [];
  const host = { store: new FakeMemoryStore(), characterId: 'alice', random: cryptoRandom, show: (display: PluginDisplay) => shown.push(display) };
  const session = new PluginSession([{ plugin, tools: pluginTools(plugin, host), always: true }]);
  const system = renderSystemPrompt(persona, { now: new Date(), userName: null, plugins: session.promptContext() });
  const calls: { call: ToolCall; result: JsonValue }[] = [];
  const llm = withLocalTools(provider, () => session.tools(), { onCall: (call, result) => calls.push({ call, result }) });
  const started = performance.now();
  let answer = '';
  for await (const chunk of llm.stream({ modelId, messages: [{ role: 'system', content: system }, ...earlier.map((message) => (message.role === 'user' ? { role: 'user' as const, content: message.content } : { role: 'assistant' as const, content: message.content, toolCalls: [] })), { role: 'user', content: text }], tools: [], temperature: null, maxOutputTokens: 6000 })) {
    if (chunk.type === 'text-delta') answer += chunk.text;
  }
  const draws = calls.filter((entry) => entry.call.name === 'tarot__draw_spread');
  const last = draws.at(-1);
  const result = (last?.result ?? null) as { spread?: PluginRow; cards?: PluginRow[] } | null;
  const drawn = draws.flatMap((entry) => ((entry.result as { cards?: PluginRow[] } | null)?.cards ?? []));
  const names = drawn.map((card) => String(card['name']));
  const reversed = drawn.filter((card) => card['reversed'] === true);
  // Said reversed: "reversed" within the same paragraph as the card's name.
  const paragraphs = answer.split(/\n\s*\n/u);
  const reversedSaid = reversed.filter((card) => paragraphs.some((paragraph) => named(paragraph, String(card['name'])) && /revers|upside[- ]down/iu.test(paragraph))).length;
  return {
    drawn,
    spread: result?.spread === undefined ? null : String(result.spread['id']),
    shown: shown.length > 0 && shown.at(-1)?.items.length === (result?.cards?.length ?? -1),
    missing: names.filter((name) => !named(answer, name)),
    // Going back to an earlier reading's cards is fine; naming a card from neither is not.
    extra: deck.filter((name) => !names.includes(name) && !(earlier.length > 0 && EARLIER_CARDS.includes(name)) && named(answer, name)),
    reversedSaid,
    reversedDrawn: reversed.length,
    text: answer.trim(),
    ms: performance.now() - started,
  };
}

const rows: string[] = [];
const detail: string[] = [];
for (const modelId of MODELS) {
  let right = 0;
  let three = 0;
  let saidReversed = 0;
  let drewReversed = 0;
  const times: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const prompts = CASE === 'later' ? LATER_PROMPTS : PROMPTS;
    const prompt = prompts[run % prompts.length] ?? 'Read my cards.';
    let outcome: Outcome;
    try {
      outcome = await ask(modelId, prompt, CASE === 'later' ? EARLIER : []);
    } catch (error) {
      outcome = { drawn: [], spread: `error: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`, shown: false, missing: [], extra: [], reversedSaid: 0, reversedDrawn: 0, text: '', ms: 0 };
    }
    times.push(outcome.ms);
    const ok = outcome.drawn.length > 0 && outcome.shown && outcome.missing.length === 0 && outcome.extra.length === 0;
    if (ok) right += 1;
    if (outcome.spread === 'three') three += 1;
    saidReversed += outcome.reversedSaid;
    drewReversed += outcome.reversedDrawn;
    const cards = outcome.drawn.map((card) => `${String(card['name'])}${card['reversed'] === true ? ' (rev.)' : ''}`).join(', ');
    const why = ok ? '✓' : `✗${outcome.drawn.length === 0 ? ' no draw' : ''}${outcome.drawn.length > 0 && !outcome.shown ? ' not shown' : ''}${outcome.missing.length > 0 ? ` missing ${outcome.missing.join(', ')}` : ''}${outcome.extra.length > 0 ? ` named ${outcome.extra.join(', ')}` : ''}`;
    const line = `${modelId}: "${prompt}" → ${outcome.spread ?? 'no spread'}: ${cards || '—'} ${why} (${(outcome.ms / 1000).toFixed(1)} s) — ${outcome.text.slice(0, 160).replaceAll('\n', ' ')}`;
    console.log(line);
    detail.push(`- ${line}`);
  }
  const median = times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0;
  rows.push(`| ${modelId} | ${right}/${RUNS} | ${three}/${RUNS} | ${saidReversed}/${drewReversed} | ${(median / 1000).toFixed(1)} s |`);
}

mkdirSync(new URL('../../../docs/runs/', import.meta.url), { recursive: true });
writeFileSync(
  new URL(CASE === 'later' ? '../../../docs/runs/P10-T06-tarot-later.md' : '../../../docs/runs/P10-T06-tarot.md', import.meta.url),
  [
    CASE === 'later' ? '# P10-T06 — Tarot, live, after an earlier reading and a chat (TAROT_CASE=later)' : '# P10-T06 — Tarot, live',
    '',
    `\`pnpm live:tarot\`, ${new Date().toISOString().slice(0, 10)}. Alice with \`plugins/tarot\` ${String(plugin.manifest.version)} loaded directly, asked to read their cards (${PROMPTS.length} wordings in turn),`,
    `${RUNS} runs a model, real draws (\`crypto.getRandomValues\`). **Right**: she drew with the tool, the spread reached the wall, and her answer named every card drawn and no other card`,
    'of the 78. **Three cards**: she chose the three-card spread, the instructions\' default. **Reversed said**: reversed cards called reversed in the paragraph that names them.',
    'Through Ollama on Rick\'s PC; the median is the whole answer.',
    '',
    '| Model | Right | Three cards | Reversed said | Median answer |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## Every answer',
    '',
    ...detail,
    '',
  ].join('\n'),
);
console.log('wrote docs/runs/P10-T06-tarot.md');
