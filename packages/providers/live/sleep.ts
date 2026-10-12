import { FakeMemoryStore, MERGE_MARKER } from '@latentpresence/core';
import { FORGETFUL_WRITES, LONG_REPLAY, topicCounts } from '../../core/src/memory/fixtures/long-replay';
import { ForgetfulExtractor, replayEvenings } from '../../core/src/memory/fixtures/replay';
import type { CancellationSignal, LlmRequest, LlmStreamChunk, LLMProvider } from '@latentpresence/protocol';
import { OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * The live sleep check (P6-T04, ADR-53, `pnpm live:sleep`): the long replay — Sam over twelve
 * evenings, about twenty things retold in other words — sleeping after every evening, counting
 * what she believes after each.
 *
 * - Default: a real model extracts and merges. `SLEEP=0`: never sleeps. Writes
 *   `live/out/sleep-<model>-<on|off>.json`.
 * - `FORGETFUL=1`: an extractor that ignores the known facts writes every line's facts in its own
 *   wording (a weaker model's habit), and the real model merges them in its sleep. Its merge
 *   replies are recorded to `packages/core/src/memory/fixtures/long-replay.recording.ts`, which the
 *   unit test replays without a model.
 *
 * Hand-run, never gated.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const OLLAMA = env('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434/v1';
const real = new OpenAICompatibleLLMProvider({ id: 'ollama', baseUrl: OLLAMA.endsWith('/v1') ? OLLAMA : `${OLLAMA}/v1` });
const modelId = env('SLEEP_OLLAMA_MODEL') ?? 'glm-5.2:cloud';
const SLEEP = env('SLEEP') !== '0';
const FORGETFUL = env('FORGETFUL') === '1';

/** Passes requests to the model and keeps every reply, with which job asked. */
class Recording implements LLMProvider {
  readonly id = 'recording';
  readonly replies: { readonly kind: 'extract' | 'merge'; readonly reply: string }[] = [];
  async listModels(): Promise<never[]> {
    return [];
  }
  async *stream(request: LlmRequest, options?: { readonly signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
    const system = request.messages.find((message) => message.role === 'system');
    const kind = system !== undefined && 'content' in system && typeof system.content === 'string' && system.content.includes(MERGE_MARKER) ? 'merge' : 'extract';
    let reply = '';
    for await (const chunk of real.stream(request, options)) {
      if (chunk.type === 'text-delta') reply += chunk.text;
      yield chunk;
    }
    this.replies.push({ kind, reply });
  }
}

const recording = new Recording();
const llm: LLMProvider = FORGETFUL ? new ForgetfulExtractor(FORGETFUL_WRITES, recording) : recording;
const started = performance.now();
const run = await replayEvenings({ store: new FakeMemoryStore(), llm, modelId, exchanges: LONG_REPLAY, sleep: SLEEP || FORGETFUL });
for (const count of run.counts) console.log(`${count.evening}: ${count.exchanges} exchanges, ${count.facts} facts`);
console.log(`\ntopics (1 is right): ${JSON.stringify(topicCounts(run.current))}`);
console.log(`errors: ${JSON.stringify(run.errors)}`);
console.log(`${((performance.now() - started) / 1000).toFixed(0)} s; current facts:`);
for (const fact of run.current) console.log(`  ${fact.id}: ${fact.subject} ${fact.predicate} ${fact.object}`);

if (FORGETFUL) {
  const merges = recording.replies.filter((entry) => entry.kind === 'merge').map((entry) => entry.reply);
  const file = new URL('../../core/src/memory/fixtures/long-replay.recording.ts', import.meta.url);
  writeFileSync(
    file,
    [
      '/**',
      ' * Recorded by `FORGETFUL=1 pnpm live:sleep` (P6-T04): the model\'s answers to every merge request',
      ' * sleep made over the long replay with a forgetful extractor, in order. Replayed by',
      ' * `long-replay.test.ts` without a model. Regenerate rather than edit.',
      ' */',
      `export const LONG_MERGE_MODEL = ${JSON.stringify(modelId)};`,
      `export const LONG_MERGE_RECORDED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))};`,
      `export const LONG_MERGE_REPLIES: readonly string[] = ${JSON.stringify(merges, null, 2)};`,
      '',
    ].join('\n'),
  );
  console.log(`recorded ${merges.length} merge replies to fixtures/long-replay.recording.ts`);
} else {
  const out = new URL('out/', import.meta.url);
  mkdirSync(out, { recursive: true });
  writeFileSync(new URL(`sleep-${modelId.replaceAll(/[^a-z0-9.-]+/giu, '_')}-${SLEEP ? 'on' : 'off'}.json`, out), JSON.stringify({ modelId, sleep: SLEEP, ...run, replies: recording.replies }, null, 2));
  console.log('wrote live/out/');
}
