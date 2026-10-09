import { chunkText, documentSearchTool, renderSystemPrompt, withLocalTools } from '@latentpresence/core';
import { PersonaSchema, type DocumentHit } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider, companionIngest } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live citation check (P5-T04, `pnpm live:cite`): P5-T04's done-when — answers to five
 * private-document questions cite the right chunk — with a real model, the real prompt, her
 * real `documents_search` tool and the companion's real search (`LP_COMPANION_URL`, default
 * `http://127.0.0.1:8787`), which must already have indexed a folder holding the five facts
 * below (`docs/SURFACE.md`, "Cited answers", says how the set was made).
 *
 * A question passes when she searched, cited at least once, cited only refs a search gave her,
 * and one cited chunk holds the fact. Her citations are read the way the page reads them: the
 * answer through `chunkText`, the `cite` tags off its chunks. `CITE_RUNS=3` repeats and counts.
 * Hand-run, never gated. Writes `live/out/cite.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const modelId = env('CITE_OLLAMA_MODEL') ?? 'glm-5.2:cloud';
const companionUrl = env('LP_COMPANION_URL') ?? 'http://127.0.0.1:8787';
const RUNS = Number(env('CITE_RUNS') ?? '1');

/**
 * Five facts no model can know, each in one place: the question, words the right chunk holds,
 * and words her answer must say — numbers either way, since she spells them out for speech.
 */
const QUESTIONS: readonly { readonly ask: string; readonly fact: RegExp; readonly answer: RegExp }[] = [
  { ask: 'The boiler locked out again. How long do I hold the reset button?', fact: /eleven seconds/u, answer: /eleven|11/iu },
  { ask: 'Where did I say the spare greenhouse key is?', fact: /third blue pot/u, answer: /blue pot/iu },
  { ask: 'What pressure should the rear tyre on my gravel bike be?', fact: /rear 38 psi/u, answer: /38|thirty-eight/iu },
  { ask: 'How much notice does my landlord need before I move out?', fact: /forty-seven days/u, answer: /forty-seven|47/iu },
  { ask: "What's the guest wifi network called again?", fact: /called Lantern/u, answer: /Lantern/u },
];

const ingest = companionIngest({ baseUrl: companionUrl });

interface Outcome {
  readonly ask: string;
  readonly searched: number;
  readonly cited: readonly string[];
  readonly invented: readonly string[];
  readonly right: boolean;
  readonly answered: boolean;
  readonly where: string;
  readonly answer: string;
  readonly raw: string;
}

async function ask(question: (typeof QUESTIONS)[number]): Promise<Outcome> {
  const given = new Map<string, DocumentHit>();
  let searched = 0;
  const tool = documentSearchTool((query, limit) => ingest.search(query, limit), {
    onFound: (hits) => {
      searched += 1;
      for (const hit of hits) given.set(`c${hit.chunkId}`, hit);
    },
  });
  const llm = withLocalTools(provider, () => [tool]);
  const system = renderSystemPrompt(persona, { now: new Date(), userName: null, documents: true });
  let raw = '';
  for await (const chunk of llm.stream({ modelId, messages: [{ role: 'system', content: system }, { role: 'user', content: question.ask }], tools: [], temperature: null, maxOutputTokens: null })) {
    if (chunk.type === 'text-delta') raw += chunk.text;
  }
  const chunks = chunkText(raw);
  const cited = [...new Set(chunks.flatMap((chunk) => chunk.tags.filter((tag) => tag.kind === 'cite').map((tag) => tag.value)))];
  const invented = cited.filter((ref) => !given.has(ref));
  const hits = cited.flatMap((ref) => given.get(ref) ?? []);
  const right = hits.some((hit) => question.fact.test(hit.text));
  const spoken = chunks.map((chunk) => chunk.text).join(' ');
  const where = hits.map((hit) => `${hit.title}${hit.locator === null ? '' : `, ${hit.locator}`}`).join('; ');
  return { ask: question.ask, searched, cited, invented, right, answered: question.answer.test(spoken), where, answer: spoken, raw };
}

const status = await ingest.status();
console.log(`companion ${companionUrl}: ${status.folders.map((folder) => `${folder.path} (${folder.documents} documents)`).join(', ')}; embedding ${status.embedding?.model ?? 'none'}`);

const report: string[] = [`# live:cite — ${modelId}, ${new Date().toISOString()}`, ''];
let passed = 0;
let total = 0;
for (let run = 1; run <= RUNS; run += 1) {
  for (const question of QUESTIONS) {
    const outcome = await ask(question);
    const pass = outcome.searched > 0 && outcome.cited.length > 0 && outcome.invented.length === 0 && outcome.right && outcome.answered;
    total += 1;
    if (pass) passed += 1;
    const line = `${pass ? 'PASS' : 'FAIL'} run ${run}: ${outcome.ask} — searched ${outcome.searched}, cited ${outcome.cited.join(' ') || 'nothing'}${outcome.invented.length > 0 ? ` (not given: ${outcome.invented.join(' ')})` : ''} → ${outcome.where || '—'}`;
    console.log(line);
    // A failure shows what she wrote, tags and all: a tag the grammar refused looks like none.
    report.push(`- ${line}`, `  > ${(pass ? outcome.answer : `(as written) ${outcome.raw}`).replaceAll('\n', ' ')}`);
  }
}
console.log(`${passed}/${total} cited the right chunk`);
report.push('', `**${passed}/${total}** cited the right chunk.`);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/cite.md', import.meta.url), `${report.join('\n')}\n`);
