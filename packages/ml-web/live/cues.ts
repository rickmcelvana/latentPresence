import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';
import { scheduleCues } from '@latentpresence/avatar';
import { trimToVoice } from '@latentpresence/core';
import type { InlineTag } from '@latentpresence/protocol';
import { KokoroTTS } from 'kokoro-js';
import { ASR_MODELS, ASR_SAMPLE_RATE } from '../src/asr/messages';
import { resample } from '../src/asr/resample';
import { KOKORO_MODEL_ID } from '../src/kokoro/messages';

/**
 * The live tag-timing check (P2-T07, `pnpm live:cues`): does a tag fire on its word?
 *
 * Neither TTS provider reports word timings, so `scheduleCues` places a tag by character
 * across the sentence's voiced span. This measures that estimate against a listener that
 * is not the estimator: **Kokoro speaks, the audio is trimmed exactly as `Reply` trims it
 * (ADR-27), and Whisper base — the `_timestamped` export — says where each word starts.**
 * Every word is scored as if a tag sat on it, not only five: the done-when is "each tag
 * within 100 ms of its word", and a tag can sit on any word.
 *
 * Whisper's word times come from cross-attention alignment and carry their own error of a
 * few tens of ms, so this is an upper bound on the estimate's error, not the error itself.
 * A sentence whose transcript does not split into the same number of words is listed and
 * left out — matching words by index would then compare different words.
 */

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const SENTENCES = [
  'Oh, hello! It is lovely to see you again.',
  'Honestly, I was not sure you would come back today.',
  'Let me think about that for a second, because it is a good question.',
  'The afternoon light came in low across the desk, and it caught the dust in the air.',
  'I remember thinking that I would like to keep that feeling for a little longer.',
  'We walked along the river until the path gave out into long wet grass.',
  'Could you pass me the blue folder on the second shelf?',
  'That is wonderful news, and I am really happy for you.',
] as const;

const RATE = 24_000;
const BAR_MS = 100;

type Recogniser = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text?: string; chunks?: { text?: string; timestamp?: readonly (number | null)[] }[] }>;
const build = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Recogniser>;

console.log('speaking with Kokoro q8, timing words with Whisper base (timestamped) q8, both onnxruntime-node\n');
const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8', device: 'cpu' });
const recognise = await build('automatic-speech-recognition', ASR_MODELS['whisper-base'].modelId, { device: 'cpu', dtype: 'q8' });

const errors: number[] = [];
const lines: string[] = [];
const skipped: string[] = [];

for (const text of SENTENCES) {
  const audio = await tts.generate(text, { voice: 'af_heart', speed: 1 });
  if (audio.sampling_rate !== RATE) throw new Error(`Kokoro spoke at ${audio.sampling_rate} Hz`);
  // Exactly what plays: `Reply` trims to the voice with ADR-27's 50 / 250 ms padding.
  const played = trimToVoice(Float32Array.from(audio.audio), RATE);
  const ms = (frames: number): number => Math.round((frames / RATE) * 1000);
  const timing = { durationMs: ms(played.samples.length), voicedStartMs: ms(played.voicedStart), voicedEndMs: ms(played.voicedEnd) };

  const output = await recognise(resample(played.samples, RATE, ASR_SAMPLE_RATE), { return_timestamps: 'word' });
  const heard = (output.chunks ?? []).map((chunk) => ({ text: (chunk.text ?? '').trim(), startMs: Math.round((chunk.timestamp?.[0] ?? 0) * 1000) }));
  const words = [...text.matchAll(/\S+/gu)].map((match) => ({ text: match[0], offset: match.index ?? 0 }));
  if (heard.length !== words.length) {
    skipped.push(`- "${text}" — Whisper gave ${heard.length} words for ${words.length}: ${heard.map((word) => word.text).join(' ')}`);
    continue;
  }

  const tags: InlineTag[] = words.map((word) => ({ kind: 'gesture', value: 'nod', known: 'nod', offset: word.offset }));
  const cues = scheduleCues(text, tags, timing);
  const row = words.map((word, index) => {
    const estimate = cues[index]?.atMs ?? 0;
    const truth = heard[index]?.startMs ?? 0;
    errors.push(estimate - truth);
    return `${word.text} ${estimate - truth >= 0 ? '+' : ''}${estimate - truth}`;
  });
  lines.push(`| ${text} | ${timing.voicedStartMs}–${timing.voicedEndMs} | ${row.join(' · ')} |`);
  console.log(`${text}\n  ${row.join('  ')}`);
}

const sorted = errors.map(Math.abs).toSorted((a, b) => a - b);
const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const within = sorted.filter((value) => value < BAR_MS).length;
const mean = errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length);
const summary = [
  `**${errors.length} words** from ${SENTENCES.length - skipped.length} sentences: |error| median **${pick(0.5)} ms**, p90 **${pick(0.9)} ms**, max **${sorted.at(-1) ?? 0} ms**; mean signed error ${mean.toFixed(0)} ms (+ is late).`,
  `**${within} of ${errors.length} within ${BAR_MS} ms** (${((100 * within) / Math.max(1, errors.length)).toFixed(0)}%).`,
];
console.log(`\n${summary.join('\n')}`);
if (skipped.length > 0) console.log(`\nskipped:\n${skipped.join('\n')}`);

writeFileSync(
  join(out, 'cues.md'),
  [
    '# live:cues — does a tag fire on its word?',
    '',
    'Kokoro q8 af_heart, trimmed as `Reply` trims (50 / 250 ms). Estimate: `scheduleCues` by character over the voiced span. Truth: Whisper base timestamped word starts. Error = estimate − truth, ms.',
    '',
    ...summary,
    '',
    '| sentence | voiced ms | per-word error |',
    '|---|---|---|',
    ...lines,
    '',
    ...(skipped.length > 0 ? ['Skipped:', ...skipped] : []),
  ].join('\n'),
);
