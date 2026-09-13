import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';
import { heardText, voicedRange, type SpokenSentence } from '@latentpresence/core';
import { KokoroTTS } from 'kokoro-js';
import { ASR_MODELS, moonshineTokenBudget } from '../src/asr/messages';
import { resample } from '../src/asr/resample';
import { KOKORO_MODEL_ID } from '../src/kokoro/messages';

/**
 * The live barge-in check (P1-T08, `pnpm live:bargein`): is the spoken prefix right?
 *
 * Neither TTS provider returns word timings, so `assistant.interrupted.spokenPrefix` is an
 * estimate from how much audio was rendered. This measures it against a listener that is
 * not the estimator: **Kokoro speaks a sentence, the audio is cut at a random frame and
 * faded over 100 ms exactly as the worklet does, and Moonshine writes down what is left.**
 * The estimator is asked about the same cut — the fade's midpoint, as `Reply` asks — and
 * the two word counts are compared.
 *
 * - **ahead**: the estimate claims words Moonshine did not hear. The expensive error: the
 *   transcript and memory would say the character told the user something it never did.
 * - **behind**: Moonshine heard more than the estimate claims. The conservative error, and
 *   partly by design — a word counts only once its estimated end has played, while a
 *   recogniser will often complete a half-heard word.
 *
 * Three estimators run on the same cuts, so the choice between them is measured: character
 * proportion over the voiced range (what ships), over the whole padded sentence, and the
 * voiced range counted to the fade's *start* rather than its midpoint.
 *
 * Moonshine needs silence after the last word to emit its end token (`docs/SURFACE.md`),
 * so every cut gets the same padding: without it this would measure Moonshine.
 *
 * **An empty transcript is not a listener hearing nothing.** The first run had Moonshine
 * return "" for 10 of 64 cuts, one of them 2.6 s of clear speech, and scored every one as
 * the estimate running ahead. Those rows are counted as unreadable and left out of the
 * comparison; they are still listed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(join(out, 'models'), { recursive: true });

const SENTENCES = [
  'The afternoon light came in low across the desk, and it caught the dust in the air.',
  'For a while nobody said anything, because there was nothing that needed saying.',
  'Then the kettle clicked off in the kitchen, and the moment was over.',
  'I remember thinking that I would like to keep that feeling for a little longer.',
  'Could you pass me the blue folder on the second shelf?',
  'We walked along the river until the path gave out into long wet grass.',
  'Honestly, I think the second version reads better than the first one did.',
  'She laughed, put the phone down, and went back to her crossword.',
] as const;

const CUTS_PER_SENTENCE = 8;
const RATE = 24_000;
const FADE_FRAMES = 2400; // 100 ms at 24 kHz, the plan's fade
const ASR_RATE = 16_000;

/** Deterministic, so a rerun measures the same cuts. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const normalise = (text: string): string[] =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s']/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word !== '');

/** How many of the reference's leading words the transcript reproduces, in order. */
function leadingMatch(reference: string, transcript: string): number {
  const ref = normalise(reference);
  const hyp = normalise(transcript);
  let count = 0;
  while (count < ref.length && count < hyp.length && ref[count] === hyp[count]) count += 1;
  return count;
}

interface Recogniser {
  (audio: Float32Array, options: Record<string, unknown>): Promise<{ text?: string }>;
}
const build = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Recogniser>;

console.log('speaking with Kokoro q8, listening with Moonshine tiny q8 (both onnxruntime-node)\n');
const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8', device: 'cpu' });
const recognise = await build('automatic-speech-recognition', ASR_MODELS['moonshine-tiny'].modelId, {
  device: 'cpu',
  dtype: 'q8',
});

type Estimator = 'voiced, fade midpoint' | 'whole sentence, fade midpoint' | 'voiced, fade start';
const ESTIMATORS: readonly Estimator[] = ['voiced, fade midpoint', 'whole sentence, fade midpoint', 'voiced, fade start'];

interface Row {
  readonly sentence: number;
  readonly cutMs: number;
  readonly heard: string;
  readonly heardWords: number;
  readonly estimates: Record<Estimator, { text: string; words: number }>;
}

const rows: Row[] = [];
const random = prng(20260913);
const edges: string[] = [];

for (const [index, text] of SENTENCES.entries()) {
  const audio = await tts.generate(text, { voice: 'af_heart', speed: 1 });
  const samples = Float32Array.from(audio.audio);
  if (audio.sampling_rate !== RATE) throw new Error(`Kokoro spoke at ${audio.sampling_rate} Hz`);
  const voiced = voicedRange(samples);
  edges.push(
    `| ${index + 1} | ${Math.round((samples.length / RATE) * 1000)} | ${Math.round((voiced.start / RATE) * 1000)} | ${Math.round(((samples.length - voiced.end) / RATE) * 1000)} | ${(samples[0] ?? 0).toFixed(4)} | ${(samples.at(-1) ?? 0).toFixed(4)} |`,
  );

  const voicedSentence: SpokenSentence = { text, frames: samples.length, sampleRate: RATE, voicedStart: voiced.start, voicedEnd: voiced.end };
  const wholeSentence: SpokenSentence = { text, frames: samples.length, sampleRate: RATE };

  for (let c = 0; c < CUTS_PER_SENTENCE; c += 1) {
    const cut = Math.round(voiced.start + random() * (voiced.end - voiced.start));
    // What the listener gets: everything to the cut, then the worklet's linear fade.
    const heardAudio = new Float32Array(Math.min(samples.length, cut + FADE_FRAMES));
    for (let i = 0; i < heardAudio.length; i += 1) {
      const gain = i < cut ? 1 : 1 - (i - cut) / FADE_FRAMES;
      heardAudio[i] = (samples[i] ?? 0) * gain;
    }
    const at16k = resample(heardAudio, RATE, ASR_RATE);
    const padded = new Float32Array(Math.round(0.3 * ASR_RATE) + at16k.length + Math.round(0.5 * ASR_RATE));
    padded.set(at16k, Math.round(0.3 * ASR_RATE));
    const heard = ((await recognise(padded, { max_new_tokens: moonshineTokenBudget(padded.length, ASR_RATE) })).text ?? '').trim();

    const estimate = (sentence: SpokenSentence, frame: number) => {
      const prefix = heardText(sentence, frame);
      return { text: prefix, words: normalise(prefix).length };
    };
    rows.push({
      sentence: index + 1,
      cutMs: Math.round((cut / RATE) * 1000),
      heard,
      heardWords: leadingMatch(text, heard),
      estimates: {
        'voiced, fade midpoint': estimate(voicedSentence, cut + FADE_FRAMES / 2),
        'whole sentence, fade midpoint': estimate(wholeSentence, cut + FADE_FRAMES / 2),
        'voiced, fade start': estimate(voicedSentence, cut),
      },
    });
  }
  console.log(`sentence ${index + 1}: ${CUTS_PER_SENTENCE} cuts`);
}

const lines: string[] = [
  `# Barge-in spoken prefix — ${new Date().toISOString().slice(0, 10)}`,
  '',
  `Kokoro q8 af_heart, ${SENTENCES.length} sentences × ${CUTS_PER_SENTENCE} seeded cuts in the voiced range, 100 ms linear fade, Moonshine tiny q8 with 300 ms lead and 500 ms tail.`,
  'Moonshine words = leading reference words reproduced in order. diff = estimate − Moonshine: positive is **ahead** (claims unheard words).',
  '',
  '## Summary',
  '',
  `${rows.filter((row) => row.heard === '').length} of ${rows.length} cuts came back from Moonshine empty and are left out below.`,
  '',
  '| estimator | exact | behind 1 | behind 2+ | ahead 1 | ahead 2+ | mean |diff| |',
  '|---|---|---|---|---|---|---|',
];
const readable = rows.filter((row) => row.heard !== '');
for (const estimator of ESTIMATORS) {
  const diffs = readable.map((row) => row.estimates[estimator].words - row.heardWords);
  const count = (predicate: (d: number) => boolean) => diffs.filter(predicate).length;
  const mean = diffs.reduce((sum, d) => sum + Math.abs(d), 0) / diffs.length;
  lines.push(
    `| ${estimator} | ${count((d) => d === 0)} | ${count((d) => d === -1)} | ${count((d) => d <= -2)} | ${count((d) => d === 1)} | ${count((d) => d >= 2)} | ${mean.toFixed(2)} |`,
  );
}
lines.push('', '## Sentence edges', '', '| # | ms | leading silence ms | trailing silence ms | first sample | last sample |', '|---|---|---|---|---|---|', ...edges);
lines.push('', '## Rows (voiced, fade midpoint — what ships)', '', '| # | cut ms | Moonshine heard | estimate | diff |', '|---|---|---|---|---|');
for (const row of rows) {
  const shipped = row.estimates['voiced, fade midpoint'];
  const diff = row.heard === '' ? 'unreadable' : String(shipped.words - row.heardWords);
  lines.push(`| ${row.sentence} | ${row.cutMs} | ${row.heard} | ${shipped.text} | ${diff} |`);
}

const report = lines.join('\n');
writeFileSync(join(out, 'bargein.md'), `${report}\n`);
console.log(`\n${report}\n\nwritten to live/out/bargein.md`);
