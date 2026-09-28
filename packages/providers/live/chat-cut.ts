import { renderSystemPrompt } from '@latentpresence/core';
import { PersonaSchema } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Does glm-5.2:cloud's cut reach `/chat`? (`pnpm live:chat-cut`, 2026-09-28.)
 *
 * P4-T03 found Ollama's OpenAI-compatible stream for glm-5.2:cloud sometimes starting the
 * answer mid-way where reasoning ends (`docs/SURFACE.md`). `/chat` runs glm with reasoning on
 * and its replies usually open with an inline tag, so a cut there is spoken as a fragment
 * ("te:joy] …") or loses the feeling. This sends forty varied messages, one turn each, with the
 * real persona prompt, **twice** — reasoning on (as `/chat` does today) and off
 * (`reasoning_effort: "none"`, what `LlmRequest.reasoning: 'off'` sends) — and reads the raw
 * SSE, so both the reasoning and the answer are seen exactly as Ollama sent them.
 *
 * A reply is **cut** when it does not start the way a reply can: a complete `[kind:value]`
 * tag, or a sentence start (a capital, a digit, a quote or bracket, `…`). A lowercase start is
 * listed separately and read by eye — "ha" can be real. Latency is to the first answer
 * character and to the end. Hand-run, never gated. `CHAT_CUT_RUNS` repeats the set. Writes
 * `live/out/chat-cut.md`.
 */

process.loadEnvFile('../../.env');

const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/?$/, '');
const BASE = OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1`;
const MODEL = process.env.CHAT_CUT_MODEL ?? 'glm-5.2:cloud';
const RUNS = Number(process.env.CHAT_CUT_RUNS ?? '1');

const persona = PersonaSchema.parse(JSON.parse(readFileSync(new URL('../../../personas/alice.persona.json', import.meta.url), 'utf8')));
const SYSTEM = renderSystemPrompt(persona, { now: new Date(), userName: null });

const MESSAGES: readonly string[] = [
  'Hey, how are you?',
  'I got the job!!',
  "My dad's in hospital again.",
  'How far away is the moon?',
  'Give me three tips for sleeping better.',
  'Tell me about your day.',
  'What do you actually enjoy?',
  'Ha.',
  'Are you a real person?',
  'I think I made a mistake.',
  'Explain how a fridge works, briefly.',
  'Sorry, that was a lot.',
  'Say something funny.',
  'What should I cook tonight?',
  'You are completely wrong about that.',
  'Mm.',
  'I miss my grandmother.',
  'Guess what happened at work today.',
  'Can you help me write a text to my landlord?',
  'I am so angry at my brother right now.',
  'What is 17 times 23?',
  'Do you like rain?',
  'I just adopted a puppy!',
  "I can't sleep.",
  'Tell me a fact about octopuses.',
  'Why is the sky blue?',
  'I failed my driving test.',
  'Recommend a book.',
  'Good morning!',
  'Goodnight.',
  "What's your favourite colour?",
  'I have a job interview tomorrow and I am terrified.',
  'lol',
  'Do you ever get bored?',
  'My cat knocked my coffee over.',
  'What would you do with a free day?',
  'I finished the marathon!',
  'Is it okay to feel nothing sometimes?',
  'Tell me something nice.',
  'Thanks for listening.',
];

interface Reply {
  readonly message: string;
  readonly mode: 'on' | 'off';
  readonly content: string;
  readonly reasoningTail: string;
  readonly firstMs: number | null;
  readonly totalMs: number;
  readonly verdict: 'tag' | 'sentence' | 'lowercase' | 'cut' | 'empty';
}

const TAG_START = /^\[(emote|emotion|gesture|user|emotive)\s*:\s*[a-z-]+\]/i;
const SENTENCE_START = /^["'“‘([*_¡¿…\p{Lu}\p{N}]/u;

export function verdict(content: string): Reply['verdict'] {
  const text = content.trimStart();
  if (text === '') return 'empty';
  if (TAG_START.test(text)) return 'tag';
  if (text.startsWith('[')) return 'cut'; // a bracket that is not a whole tag
  if (/^[a-z-]*:[a-z-]+\]/i.test(text) || text.startsWith(']')) return 'cut'; // the tail of a tag
  if (SENTENCE_START.test(text)) return 'sentence';
  if (/^\p{Ll}/u.test(text)) return 'lowercase';
  return 'cut';
}

async function ask(message: string, mode: 'on' | 'off'): Promise<Reply> {
  const started = performance.now();
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: message },
      ],
      ...(mode === 'off' ? { reasoning_effort: 'none' } : {}),
    }),
  });
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
  let content = '';
  let reasoning = '';
  let firstMs: number | null = null;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.startsWith('data: {')) continue;
      const delta = (JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string; reasoning?: string } }[] }).choices?.[0]?.delta ?? {};
      if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (firstMs === null) firstMs = performance.now() - started;
        content += delta.content;
      }
    }
  }
  return { message, mode, content, reasoningTail: reasoning.slice(-80), firstMs, totalMs: performance.now() - started, verdict: verdict(content) };
}

/** The adapter's own view of a few, to confirm it passes on exactly what Ollama sent. */
async function throughAdapter(message: string): Promise<string> {
  const provider = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: BASE });
  let text = '';
  for await (const chunk of provider.stream({ modelId: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: message }], tools: [], temperature: null, maxOutputTokens: null })) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  return text;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : (sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN);
}

const replies: Reply[] = [];
for (let run = 0; run < RUNS; run += 1) {
  for (const message of MESSAGES) {
    for (const mode of ['on', 'off'] as const) {
      const reply = await ask(message, mode);
      replies.push(reply);
      process.stdout.write(reply.verdict === 'cut' ? 'X' : reply.verdict === 'lowercase' ? 'l' : reply.verdict === 'empty' ? '0' : '.');
    }
  }
}
console.log('');

const adapterCuts: string[] = [];
for (const message of MESSAGES.slice(0, 10)) {
  const text = await throughAdapter(message);
  if (verdict(text) === 'cut') adapterCuts.push(`${message} → ${JSON.stringify(text.slice(0, 40))}`);
}

const lines: string[] = [`# live:chat-cut — ${new Date().toISOString()}`, '', `${MODEL}, ${MESSAGES.length} messages × ${RUNS} run(s), each with reasoning on and off, raw SSE.`, ''];
for (const mode of ['on', 'off'] as const) {
  const set = replies.filter((reply) => reply.mode === mode);
  const count = (v: Reply['verdict']): number => set.filter((reply) => reply.verdict === v).length;
  const first = set.flatMap((reply) => (reply.firstMs === null ? [] : [reply.firstMs]));
  const words = set.map((reply) => reply.content.split(/\s+/).filter(Boolean).length);
  lines.push(
    `## reasoning ${mode}`,
    '',
    `- **cut: ${count('cut')}/${set.length}**, empty ${count('empty')}, lowercase start ${count('lowercase')} (read below), opens with a tag ${count('tag')}, sentence ${count('sentence')}`,
    `- first answer character: median ${median(first).toFixed(0)} ms, worst ${Math.max(...first).toFixed(0)} ms; whole reply median ${median(set.map((reply) => reply.totalMs)).toFixed(0)} ms`,
    `- words per reply: median ${median(words)}`,
    '',
    ...set
      .filter((reply) => reply.verdict !== 'tag' && reply.verdict !== 'sentence')
      .map((reply) => `- ${reply.verdict}: "${reply.message}" → ${JSON.stringify(reply.content.slice(0, 60))} (reasoning ended ${JSON.stringify(reply.reasoningTail.slice(-40))})`),
    '',
  );
}
lines.push('## side by side (first run)', '');
for (const message of MESSAGES) {
  const on = replies.find((reply) => reply.message === message && reply.mode === 'on');
  const off = replies.find((reply) => reply.message === message && reply.mode === 'off');
  lines.push(`- **${message}**`, `  - on: ${JSON.stringify(on?.content ?? '')}`, `  - off: ${JSON.stringify(off?.content ?? '')}`);
}
lines.push('', `Through the adapter (first ten, reasoning on): ${adapterCuts.length === 0 ? 'no cuts' : adapterCuts.join('; ')}`, '');

mkdirSync(new URL('out/', import.meta.url), { recursive: true });
writeFileSync(new URL('out/chat-cut.md', import.meta.url), `${lines.join('\n')}\n`);
console.log(lines.slice(0, 16).join('\n'));
