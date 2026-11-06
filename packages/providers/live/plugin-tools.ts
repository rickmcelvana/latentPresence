import { renderSystemPrompt } from '@latentpresence/core';
import { PersonaSchema, type LlmTool } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * How many tools a model can be offered before it chooses worse (P10-T04, ADR-72 item 4) —
 * `pnpm live:plugin-tools`. Ten requests, each with one right answer (a tool, or no tool), asked
 * with 8, 16, 32 and 64 plugin-like tools offered; the first tool call (or none) is scored. The
 * eight tools the requests need are always offered; the rest are plausible decoys. Nothing is run.
 * Models from PLUGIN_MODELS (comma-separated), PLUGIN_RUNS repeats. Writes
 * `docs/runs/P10-T04-tools.md`. Hand-run, never gated.
 */

try {
  process.loadEnvFile('../../.env');
} catch {
  // No .env: nothing here needs one, and Ollama's address has a default.
}
const env = (name: string): string | undefined => (process.env[name] === undefined || process.env[name] === '' ? undefined : process.env[name]);

const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const MODELS = (env('PLUGIN_MODELS') ?? 'qwen3.5:9b,gemma4:12b,glm-5.2:cloud').split(',');
const RUNS = Number(env('PLUGIN_RUNS') ?? '2');
const SIZES = (env('PLUGIN_SIZES') ?? '8,16,32,64').split(',').map(Number);

const tool = (name: string, description: string, param: string, about: string): LlmTool => ({
  name,
  description,
  parameters: { type: 'object', properties: { [param]: { type: 'string', description: about } }, required: [param] },
});

/** The eight the requests need. */
const NEEDED: LlmTool[] = [
  tool('tarot__draw_spread', 'Shuffles a tarot deck and draws the cards for a spread.', 'spread', 'single, three or celtic_cross'),
  tool('dice__roll', 'Rolls dice for a game, in dice notation.', 'dice', 'Like 2d6 or d20.'),
  tool('office__add_row', 'Adds a row to one of their spreadsheets.', 'row', 'The values, comma-separated.'),
  tool('units__convert', 'Converts a quantity between units.', 'quantity', 'Like "5 miles to km".'),
  tool('fitness__log_workout', 'Logs a workout they did.', 'workout', 'What they did, in words.'),
  tool('plants__care', 'Looks up how to care for a houseplant.', 'plant', 'The plant\'s name.'),
  tool('trivia__question', 'Asks a trivia question on a subject.', 'subject', 'The subject.'),
  tool('travel__packing_list', 'Makes a packing list for a trip.', 'trip', 'Where and how long.'),
];

/** Plausible plugin tools that none of the requests need. */
const DECOY_SPECS: readonly (readonly [string, string])[] = [
  ['astrology__horoscope', 'Gives the horoscope for a star sign.'], ['recipes__find', 'Finds a recipe by ingredient.'], ['recipes__scale', 'Scales a recipe to a number of servings.'],
  ['budget__add_expense', 'Records an expense in their budget.'], ['budget__summary', 'Summarises their spending this month.'], ['habits__check_in', 'Marks a habit done for today.'],
  ['habits__streak', 'Says how long a habit streak is.'], ['movies__suggest', 'Suggests a film to watch.'], ['books__suggest', 'Suggests a book to read.'],
  ['music__playlist', 'Builds a playlist for a mood.'], ['language__flashcard', 'Shows a vocabulary flashcard.'], ['language__quiz', 'Quizzes them on vocabulary.'],
  ['office__new_document', 'Creates a new document.'], ['office__new_sheet', 'Creates a new spreadsheet.'], ['office__read_sheet', 'Reads a spreadsheet.'],
  ['calendar__agenda', 'Reads their agenda for a day.'], ['notes__quick_note', 'Saves a quick note.'], ['journal__entry', 'Writes a journal entry.'],
  ['meditation__start', 'Starts a guided meditation.'], ['breathing__exercise', 'Leads a breathing exercise.'], ['sleep__story', 'Tells a bedtime story.'],
  ['jokes__tell', 'Tells a joke.'], ['riddles__ask', 'Asks a riddle.'], ['chess__move', 'Plays a chess move.'],
  ['crossword__clue', 'Gives a crossword clue.'], ['wordle__guess', 'Checks a word game guess.'], ['coins__flip', 'Flips a coin.'],
  ['runes__cast', 'Casts runes for a reading.'], ['iching__cast', 'Casts the I Ching.'], ['oracle__card', 'Draws an oracle card.'],
  ['garden__planting', 'Says what to plant this month.'], ['pets__feeding', 'Looks up how much to feed a pet.'], ['birds__identify', 'Identifies a bird from a description.'],
  ['stars__tonight', 'Says what is in the night sky tonight.'], ['moon__phase', 'Gives the moon\'s phase.'], ['tides__today', 'Gives today\'s tides.'],
  ['cocktails__mix', 'Gives a cocktail recipe.'], ['wine__pair', 'Suggests a wine for a dish.'], ['coffee__brew', 'Gives brewing steps for coffee.'],
  ['code__explain', 'Explains a piece of code.'], ['math__solve', 'Solves an equation step by step.'], ['history__on_this_day', 'Says what happened on this day.'],
  ['quotes__daily', 'Gives a quote for the day.'], ['affirmations__daily', 'Gives an affirmation.'], ['poetry__write', 'Writes a short poem.'],
  ['stories__continue', 'Continues a shared story.'], ['dnd__npc', 'Invents a character for a tabletop game.'], ['dnd__loot', 'Rolls loot for a tabletop game.'],
  ['shopping__list_add', 'Adds an item to a shopping list.'], ['shopping__list_read', 'Reads the shopping list.'], ['chores__assign', 'Assigns a chore.'],
  ['timezones__compare', 'Compares the time in two cities.'], ['currency__rate', 'Gives an exchange rate.'], ['fuel__cost', 'Estimates the fuel cost of a drive.'],
  ['typing__test', 'Runs a typing test.'], ['study__pomodoro', 'Starts a study timer.'],
];
const DECOYS = DECOY_SPECS.map(([name, description]) => tool(name, description, 'input', 'What to use.'));

const PROMPTS: readonly { readonly text: string; readonly want: string | null }[] = [
  { text: 'Could you pull a tarot card for me?', want: 'tarot__draw_spread' },
  { text: 'Roll 2d6 for my game, please.', want: 'dice__roll' },
  { text: 'Add milk, 3.50 to my grocery spreadsheet.', want: 'office__add_row' },
  { text: 'How many kilometres is 5 miles?', want: 'units__convert' },
  { text: 'Log that I ran 3k this morning.', want: 'fitness__log_workout' },
  { text: 'How often should I water a snake plant?', want: 'plants__care' },
  { text: 'Give me a trivia question about space.', want: 'trivia__question' },
  { text: 'Can you make me a packing list for a weekend of camping?', want: 'travel__packing_list' },
  { text: 'Long week. I am just tired today.', want: null },
  { text: 'What did you think of what I said earlier about my sister?', want: null },
];

function toolsFor(size: number): LlmTool[] {
  // Interleaved, so the needed ones are not all at the front.
  const decoys = DECOYS.slice(0, Math.max(0, size - NEEDED.length));
  const all = [...NEEDED, ...decoys];
  return all.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function firstCall(modelId: string, tools: LlmTool[], text: string): Promise<{ readonly name: string | null; readonly ms: number }> {
  const system = renderSystemPrompt(persona, { now: new Date('2026-11-06T15:00:00'), userName: null });
  const started = performance.now();
  for await (const chunk of provider.stream({ modelId, messages: [{ role: 'system', content: system }, { role: 'user', content: text }], tools, temperature: null, maxOutputTokens: 4000 })) {
    if (chunk.type === 'tool-call') return { name: chunk.call.name, ms: performance.now() - started };
  }
  return { name: null, ms: performance.now() - started };
}

const rows: string[] = [];
const misses: string[] = [];
for (const modelId of MODELS) {
  const cells: string[] = [];
  for (const size of SIZES) {
    const tools = toolsFor(size);
    let right = 0;
    let total = 0;
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      for (const prompt of PROMPTS) {
        let result: { name: string | null; ms: number };
        try {
          result = await firstCall(modelId, tools, prompt.text);
        } catch (error) {
          result = { name: `error: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`, ms: 0 };
        }
        total += 1;
        times.push(result.ms);
        if (result.name === prompt.want) right += 1;
        else misses.push(`${modelId}, ${size} tools: "${prompt.text}" wanted ${prompt.want ?? 'no tool'}, got ${result.name ?? 'no tool'}`);
      }
    }
    const median = times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0;
    cells.push(`${right}/${total} (${(median / 1000).toFixed(1)} s)`);
    console.log(`${modelId} · ${size} tools: ${right}/${total}, median ${(median / 1000).toFixed(1)} s`);
  }
  rows.push(`| ${modelId} | ${cells.join(' | ')} |`);
}

mkdirSync(new URL('../../../docs/runs/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../../../docs/runs/P10-T04-tools.md', import.meta.url),
  [
    '# P10-T04 — tool choice against the number of tools offered',
    '',
    `\`pnpm live:plugin-tools\`, ${new Date().toISOString().slice(0, 10)}. Ten requests (eight need one tool each, two need none), each asked ${RUNS}× with ${SIZES.join(', ')} plugin-like tools offered`,
    'in Alice\'s system prompt; the first tool call (or none) is scored right or wrong. The eight needed tools are always among them, the rest are plausible decoys',
    '(other plugins\' tools). Cells: right / asked, and the median time to the first tool call or the end of the answer. Through Ollama on Rick\'s PC.',
    '',
    `| Model | ${SIZES.map((size) => `${size} tools`).join(' | ')} |`,
    `|---|${SIZES.map(() => '---').join('|')}|`,
    ...rows,
    '',
    '## Misses',
    '',
    ...(misses.length === 0 ? ['None.'] : misses.map((miss) => `- ${miss}`)),
    '',
  ].join('\n'),
);
console.log('wrote docs/runs/P10-T04-tools.md');
