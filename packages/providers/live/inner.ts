import { INNER_LINES, innerMessages, parseInnerLines, repeatsAnswer, withThinking } from '@latentpresence/core';
import alice from '../../../personas/alice.persona.json' with { type: 'json' };
import type { LlmMessage, LLMProvider } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';

/**
 * The live inner-monologue check (P6-T05, ADR-54, `pnpm live:inner`): a few moments answered by
 * real thinking models through `withThinking`, then put into her private lines by the same model
 * with reasoning off, as `/chat` does. Each set of lines is checked by rule: one to three, first
 * person, no meta talk, nothing repeated from what she said, nothing of the reasoning's voice.
 * `INNER_MODELS` (comma-separated) picks the models. Hand-run, never gated.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};
const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const llm = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const MODELS = (env('INNER_MODELS') ?? 'glm-5.2:cloud,deepseek-r1:8b,qwen3.5:9b').split(',');

const PERSONA = 'You are Alice, a warm, curious friend on a video call with Rick. Answer in one to three sentences, spoken aloud.';

interface Moment {
  readonly name: string;
  readonly messages: LlmMessage[];
  /** What they said; null when she speaks first. */
  readonly heard: string | null;
}

const MOMENTS: readonly Moment[] = [
  { name: 'bad meeting', heard: 'I just got back from a meeting, it went badly. Anyway, any idea what to cook tonight?', messages: [] },
  {
    name: 'slow dates',
    heard: "Still no Helsinki dates. My co-workers are slow. I'm starting to think the trip won't happen.",
    messages: [
      { role: 'user', content: "We're planning a trip to Helsinki, I'm waiting on dates from co-workers." },
      { role: 'assistant', content: "That's exciting! Let me know when the dates land and we'll plan around them.", toolCalls: [] },
    ],
  },
  {
    name: 'brother',
    heard: "I'd rather not talk about my brother right now.",
    messages: [
      { role: 'user', content: 'My brother called today.' },
      { role: 'assistant', content: 'Oh? How is he doing — you two had not talked in a while, right?', toolCalls: [] },
    ],
  },
  {
    name: 'drone',
    heard: 'Do you actually remember what I told you about the drone?',
    messages: [{ role: 'system', content: 'WHAT YOU REMEMBER: Rick has a DJI Neo drone. Rick wants to fly it in Helsinki near the waterfront.' }],
  },
  {
    name: 'opener',
    heard: null,
    messages: [
      { role: 'system', content: 'YOU SPEAK FIRST: Rick has just come back after five hours. Greet them for the evening and pick up one thing: the Helsinki dates they were waiting on.' },
      { role: 'user', content: '(They have just come back. Say hello.)' },
    ],
  },
];

const META = /\b(?:the user|persona|system prompt|instructions?|language model|as an ai)\b/iu;
const FIRST_PERSON = /\b(?:I|I'm|I'll|I'd|I've|me|my|myself)\b/u;

async function collect(provider: LLMProvider, modelId: string, messages: LlmMessage[], reasoning: 'default' | 'off'): Promise<string> {
  let text = '';
  for await (const chunk of provider.stream({ modelId, messages, tools: [], temperature: null, maxOutputTokens: null, reasoning })) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  return text;
}

let checked = 0;
let passed = 0;
const rows: string[] = [];
for (const modelId of MODELS) {
  for (const thinking of [true, false]) {
    for (const moment of MOMENTS) {
      let thought = '';
      const tapped = withThinking(llm, (text) => (thought += text));
      const messages: LlmMessage[] = [{ role: 'system', content: PERSONA }, ...moment.messages, ...(moment.heard === null ? [] : [{ role: 'user' as const, content: moment.heard }])];
      const said = (await collect(tapped, modelId, messages, thinking ? 'default' : 'off')).trim();
      const reply = await collect(llm, modelId, innerMessages({ name: alice.name, summary: alice.summary }, { heard: moment.heard, said, reasoning: thought.trim() }), 'off');
      const lines = parseInnerLines(reply, said);
      const raw = reply.split('\n').filter((line) => line.trim() !== '');
      const problems = [
        lines.length === 0 || lines.length > INNER_LINES ? `${lines.length} lines` : null,
        raw.some((line) => META.test(line)) ? 'meta (dropped)' : null,
        lines.some((line) => !FIRST_PERSON.test(line)) && !lines.some((line) => FIRST_PERSON.test(line)) ? 'not first person' : null,
        lines.some((line) => repeatsAnswer(line, said)) ? 'repeats her answer' : null,
        lines.some((line) => /\b(?:he|she|him|his)\b/iu.test(line)) ? 'he/she for them' : null,
        lines.some((line) => /^(?:okay|alright)\b/iu.test(line)) ? 'reasoning voice' : null,
        lines.some((line) => /\*\*|analy[sz]e|draft/iu.test(line)) ? 'reasoning voice' : null,
        said.includes('<think>') || said.includes(thought.slice(0, 40)) && thought.length > 40 ? 'reasoning in the answer' : null,
      ].filter((problem): problem is string => problem !== null);
      checked += 1;
      if (problems.length === 0) passed += 1;
      const row = `| ${modelId} | ${thinking ? `${thought.length} chars` : 'off'} | ${moment.name} | ${said.replaceAll('\n', ' ').replaceAll('|', '/')} | ${lines.join(' / ').replaceAll('|', '/')} | ${problems.join(', ') || 'ok'} |`;
      rows.push(row);
      console.log(row);
    }
  }
}
console.log(`\n${passed}/${checked} passed every rule`);
console.log('\n| Model | Reasoning | Moment | She said | Her lines | Rules |\n|---|---|---|---|---|---|');
for (const row of rows) console.log(row);
