import { FakeMemoryStore } from '@latentpresence/core';
import type { LLMProvider } from '@latentpresence/protocol';
import { AnthropicLLMProvider, OpenAICompatibleLLMProvider } from '@latentpresence/providers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { replayConversation } from '../../core/src/memory/fixtures/replay';
import { EXPECTED_CLOSED, EXPECTED_CURRENT, scoreFacts, THIRTY_TURNS } from '../../core/src/memory/fixtures/thirty-turns';

/**
 * The live memory check (P4-T03, `pnpm live:memory`): the thirty-turn conversation through
 * the real kernel with a real model reading the facts, scored against what she should
 * believe at the end — every expected fact present, every replaced one closed, and the
 * extras counted. `MEMORY_TARGETS=glm,fable` picks targets. `MEMORY_RECORD=glm` also writes
 * that target's replies to `core/src/memory/fixtures/thirty-turns.recording.ts`, which the
 * unit test replays with no model. Hand-run, never gated. Writes `live/out/memory.md`.
 */

process.loadEnvFile('../../.env');

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

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
    modelId: env('MEMORY_OLLAMA_MODEL') ?? 'glm-5.2:cloud',
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

const wanted = (env('MEMORY_TARGETS') ?? 'glm').split(',');
const record = env('MEMORY_RECORD');
const report: string[] = [`# live:memory — ${new Date().toISOString()}`, '', `${THIRTY_TURNS.length} exchanges; ${EXPECTED_CURRENT.length} facts expected current, ${EXPECTED_CLOSED.length} expected closed.`, ''];

for (const target of targets.filter((candidate) => wanted.includes(candidate.label))) {
  if (target.needs !== undefined) {
    console.log(`${target.label}: skipped, needs ${target.needs}`);
    continue;
  }
  const replies: string[] = [];
  const started = performance.now();
  const store = new FakeMemoryStore({ now: () => new Date('2026-09-25T00:00:00Z') });
  const { current, errors } = await replayConversation({
    store,
    llm: target.provider,
    modelId: target.modelId,
    onExtraction: (extraction) => {
      replies.push(extraction.reply);
      process.stdout.write(extraction.facts.length > 0 ? `${extraction.facts.length}` : '.');
    },
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  const score = scoreFacts(current);
  const closedTotal = store.rows.facts.filter((row) => row.fact.validTo !== null || row.expiredAt !== null).length;
  console.log(`\n${target.label}: missing ${score.missing.length}, stale ${score.stale.length}, extra ${score.extra.length}, ${current.length} current, ${closedTotal} closed, ${errors.length} errors, ${seconds} s`);
  report.push(
    `## ${target.label} (${target.modelId}) — ${seconds} s`,
    '',
    `- expected current found: **${EXPECTED_CURRENT.length - score.missing.length}/${EXPECTED_CURRENT.length}**${score.missing.length > 0 ? ` — missing: ${score.missing.join('; ')}` : ''}`,
    `- replaced facts closed: **${EXPECTED_CLOSED.length - score.stale.length}/${EXPECTED_CLOSED.length}**${score.stale.length > 0 ? ` — still believed: ${score.stale.join('; ')}` : ''}`,
    `- extra current facts: ${score.extra.length}; errors: ${errors.length}${errors.length > 0 ? ` (${errors.join('; ')})` : ''}`,
    '',
    'Current at the end:',
    '',
    ...current.map((fact) => `- \`${fact.subject} ${fact.predicate} ${fact.object}\` ${fact.confidence.toFixed(2)} from ${fact.validFrom.slice(0, 10)}`),
    '',
    'Closed:',
    '',
    ...store.rows.facts
      .filter((row) => row.fact.validTo !== null || row.expiredAt !== null)
      .map((row) => `- \`${row.fact.subject} ${row.fact.predicate} ${row.fact.object}\` ${row.fact.validTo === null ? 'expired' : `until ${row.fact.validTo.slice(0, 10)}`}`),
    '',
  );
  writeFileSync(new URL(`out/memory-replies-${target.label}.json`, import.meta.url), JSON.stringify(replies, null, 2));
  if (record === target.label) {
    const file = new URL('../../core/src/memory/fixtures/thirty-turns.recording.ts', import.meta.url);
    writeFileSync(
      file,
      [
        `// Recorded by \`pnpm live:memory\` (MEMORY_RECORD=${target.label}, ${target.modelId}) on ${new Date().toISOString().slice(0, 10)}.`,
        '// Every extraction reply, verbatim and in order; `memory.test.ts` replays them with no model.',
        `export const RECORDED_MODEL = ${JSON.stringify(target.modelId)};`,
        `export const RECORDED_REPLIES: readonly string[] = ${JSON.stringify(replies, null, 2)};`,
        '',
      ].join('\n'),
    );
    console.log(`recorded ${replies.length} replies`);
  }
}

mkdirSync(new URL('out/', import.meta.url), { recursive: true });
writeFileSync(new URL('out/memory.md', import.meta.url), `${report.join('\n')}\n`);
console.log('wrote live/out/memory.md');
