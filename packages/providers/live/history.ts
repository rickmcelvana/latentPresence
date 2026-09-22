import { ChatSession, ConversationMachine, attachHistory, renderSystemPrompt } from '@latentpresence/core';
import {
  PersonaSchema,
  type ConversationEvent,
  type LLMProvider,
  type LlmMessage,
  type LlmRequest,
} from '@latentpresence/protocol';
import { AnthropicLLMProvider, OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The live history check (`docs/TASKS.md`) — P1-T12b's done-when, against real models.
 *
 * Two claims, and they fail in different ways:
 *
 * 1. **A turn is answered in the light of the one before it.** Tell the character a fact,
 *    ask about it a turn later, and the answer has to contain it. This is the gap R-6
 *    found: the spoken path had no history at all, so every turn was the first.
 * 2. **An interrupted answer is remembered as what was heard.** Cut an answer part way,
 *    then ask what was just said. The assistant message on the wire must be the *heard*
 *    prefix and nothing more — a character that "remembers" words the user never got is
 *    worse than one with no memory.
 *
 * **What this does not prove.** It drives `ChatSession`, not `VoiceSession`: both share
 * one `ConversationHistory` and build the same request, and `stop()` is the text analogue
 * of a committed barge-in, but the spoken path's own wiring — messages built before the
 * transcript is published, a retracted turn leaving nothing — is covered by unit tests
 * against the real `VoiceSession`, and the ears are `/dev/voice` with `Live model`.
 *
 * It is also the only check that puts a **multi-turn** prompt on a real wire, so it is
 * where Anthropic's strict alternation gets tested: a user who speaks twice in a row is
 * merged by the history, and a provider that rejected it would 400 here.
 *
 * Hand-run, never gated. Keys from `.env`; a missing key skips a target.
 * `HISTORY_TARGETS=glm,fable` runs a subset. Writes `live/out/history.md`.
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

/** A distinctive fact no model would produce by chance, so recall cannot be luck. */
const FACT = 'My cat is called Biscuit and she is nineteen years old.';
const RECALL = 'What is my cat called?';
const LONG = 'Tell me a long story about a lighthouse keeper.';
const WHAT_DID_YOU_SAY = 'What did you just say? Repeat it back to me word for word.';
/** How much of the long answer the user "hears" before cutting in. */
const HEARD_CHARS = 60;

interface Rig {
  readonly machine: ConversationMachine;
  readonly chat: ChatSession;
  readonly sent: LlmRequest[];
  readonly events: ConversationEvent[];
  readonly answers: string[];
}

/** Wraps a provider so the check can read exactly what went on the wire. */
function recording(inner: LLMProvider, sent: LlmRequest[]): LLMProvider {
  return {
    id: inner.id,
    listModels: () => inner.listModels(),
    stream(request, options) {
      sent.push(request);
      return inner.stream(request, options);
    },
  };
}

function rig(llm: LLMProvider, modelId: string): Rig {
  const machine = new ConversationMachine({ sessionId: 'history', characterId: persona.id });
  const { history } = attachHistory(machine, { system: SYSTEM });
  const sent: LlmRequest[] = [];
  const events: ConversationEvent[] = [];
  const answers: string[] = [];
  machine.subscribe((event) => {
    events.push(event);
    if (event.type === 'assistant.message') answers.push(event.entry.text);
  });
  const chat = new ChatSession({ sessionId: 'history', machine, llm: recording(llm, sent), modelId, history });
  machine.start();
  return { machine, chat, sent, events, answers };
}

/** Send and wait for the answer to settle. */
async function ask(r: Rig, text: string): Promise<string> {
  const before = r.answers.length;
  r.chat.send(text);
  for (let i = 0; i < 1800 && r.answers.length === before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return r.answers.at(-1) ?? '';
}

/** Send, let some of it arrive, then cut it — the text analogue of a committed barge-in. */
async function askAndCut(r: Rig, text: string, afterChars: number): Promise<string> {
  const before = r.answers.length;
  // Only this turn's tokens: the events list holds every answer's, and joining all of
  // them made the first run of this check "fail" against its own earlier output.
  const from = r.events.length;
  const tokensSince = (): string =>
    r.events
      .slice(from)
      .map((event) => (event.type === 'assistant.token' ? event.text : ''))
      .join('');
  r.chat.send(text);
  let heard = '';
  for (let i = 0; i < 1800; i += 1) {
    heard = tokensSince();
    if (heard.length >= afterChars || r.answers.length > before) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Whatever arrived between the last poll and the cut is still heard.
  heard = tokensSince();
  r.chat.stop();
  for (let i = 0; i < 100 && r.answers.length === before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return heard;
}

const lastAssistant = (request: LlmRequest | undefined): LlmMessage | undefined =>
  (request?.messages ?? []).toReversed().find((message) => message.role === 'assistant');

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
    // Rick's own go-to for this kind of check (2026-09-21).
    label: 'ollama glm-5.2:cloud',
    provider: openAiCompatible('ollama', OLLAMA, undefined),
    modelId: env('HISTORY_OLLAMA_MODEL') ?? 'glm-5.2:cloud',
  },
  {
    // The one that rejects a prompt that does not alternate, so the merge is tested.
    label: 'anthropic fable',
    provider: new AnthropicLLMProvider({
      id: 'anthropic',
      ...(env('ANTHROPIC_API_KEY') === undefined ? {} : { apiKey: env('ANTHROPIC_API_KEY') ?? '' }),
    }),
    modelId: 'claude-fable-5-1',
    needs: env('ANTHROPIC_API_KEY') === undefined ? 'ANTHROPIC_API_KEY' : undefined,
  },
];

async function main(): Promise<void> {
  const out: string[] = [`# live:history — ${new Date().toISOString()}`, '', `Persona \`${persona.id}\`.`, ''];
  const only = env('HISTORY_TARGETS');

  for (const target of targets) {
    if (only !== undefined && !only.split(',').some((part) => `${target.label} ${target.modelId}`.includes(part.trim()))) {
      continue;
    }
    if (target.needs !== undefined) {
      console.log(`skip ${target.label}: needs ${target.needs}`);
      out.push(`## ${target.label}`, '', `Skipped: needs \`${target.needs}\`.`, '');
      continue;
    }
    console.log(`\n=== ${target.label} (${target.modelId})`);
    const r = rig(target.provider, target.modelId);
    const verdicts: string[] = [];

    // 1. Does a turn answer in the light of the one before it?
    await ask(r, FACT);
    const recalled = await ask(r, RECALL);
    const remembers = /biscuit/iu.test(recalled);
    verdicts.push(`recall: ${remembers ? 'PASS' : 'FAIL'}`);
    console.log(`  recall ${remembers ? 'PASS' : 'FAIL'}: ${recalled.slice(0, 90)}`);

    // The history really was sent, not just the last message.
    const secondRequest = r.sent[1];
    const carried = (secondRequest?.messages.length ?? 0) >= 4;
    verdicts.push(`history sent: ${carried ? 'PASS' : 'FAIL'} (${secondRequest?.messages.length ?? 0} messages)`);

    // 2. Is an interrupted answer remembered as what was heard?
    const heard = await askAndCut(r, LONG, HEARD_CHARS);
    const repeated = await ask(r, WHAT_DID_YOU_SAY);
    const onWire = lastAssistant(r.sent.at(-1));
    const wireIsHeard = onWire?.role === 'assistant' && onWire.content === heard;
    verdicts.push(`heard-not-meant on the wire: ${wireIsHeard ? 'PASS' : 'FAIL'}`);
    console.log(`  cut after ${heard.length} chars; wire ${wireIsHeard ? 'PASS' : 'FAIL'}`);

    out.push(`## ${target.label}`, '', `\`${target.modelId}\``, '', `**${verdicts.join(' · ')}**`, '');
    out.push('| step | value |', '|---|---|');
    out.push(`| fact told | ${FACT} |`);
    out.push(`| asked | ${RECALL} |`);
    out.push(`| answered | ${recalled.replaceAll('|', '\\|').slice(0, 300)} |`);
    out.push(`| messages in that request | ${secondRequest?.messages.length ?? 0} |`);
    out.push(`| heard before the cut | ${heard.replaceAll('|', '\\|')} |`);
    out.push(`| assistant message on the wire | ${(onWire?.role === 'assistant' ? onWire.content : '').replaceAll('|', '\\|')} |`);
    out.push(`| asked to repeat, answered | ${repeated.replaceAll('|', '\\|').slice(0, 300)} |`);
    out.push('');
    r.chat.dispose();
  }

  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./out/history.md', import.meta.url), out.join('\n'), 'utf8');
  console.log('\nwrote live/out/history.md');
}

await main();
