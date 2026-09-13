import { writeFileSync } from 'node:fs';
import type { SpokenAudioChunk } from '@latentpresence/protocol';
// By path, not by package: `providers` does not depend on `core` and must not start —
// core consumes providers, not the other way round. A hand-run script may reach across.
import { chunkText } from '../../core/src/chunker/chunker';
import { OpenAICompatibleTTSProvider } from '@latentpresence/providers';

/**
 * What should `maxChars` be? (`docs/TASKS.md` C-1)
 *
 * P1-T04 left the chunker's cap at 200 as a starting value and handed the measurement
 * forward. The question is not "how long can a chunk be" but **how long can the *first*
 * chunk of a turn be and still fit inside the synthesis share of ADR-20's 500 ms budget**
 * — Spike A measured that share at 245 ms on WebGPU.
 *
 * Two numbers come out of this:
 *   - the fixed per-request cost, which is what every extra chunk pays;
 *   - milliseconds of synthesis per character, which is what a longer chunk pays.
 *
 * Caveat stated up front: this measures the **server** path. The browser path is a
 * different machine doing different work and needs its own reading when P1-T08 can play
 * audio. Where the two disagree the slower one has to win, because the budget is the
 * user's ear, not ours.
 */

process.loadEnvFile('../../.env');

const baseUrl = process.env['TTS_BASE_URL'];
const model = process.env['TTS_MODEL'];
if (baseUrl === undefined || baseUrl === '' || model === undefined || model === '') {
  console.log('skip — TTS_BASE_URL / TTS_MODEL not set');
  process.exit(0);
}

const provider = new OpenAICompatibleTTSProvider({ id: 'tts', baseUrl, model });
const VOICE = 'af_heart';

/** Ordinary prose, so the phonemiser has ordinary work to do. */
const CORPUS =
  'The afternoon light came in low across the desk and everything in the room went the colour of weak tea. ' +
  'She had been talking for a while by then, about the house she grew up in and the dog that was never quite hers, ' +
  'and I had stopped taking notes because the notes were not the point and had not been for some time. ' +
  'Outside a tram went past, and then another, and the second one was almost empty. ' +
  'It is strange how a room can hold a conversation better than either person in it, how the walls seem to keep ' +
  'the shape of what was said long after the saying, and how you can walk back in a year later and feel it.';

/** A prefix of the corpus, cut at a word boundary, close to `chars` long. */
function prefix(chars: number): string {
  if (chars >= CORPUS.length) return CORPUS;
  const cut = CORPUS.lastIndexOf(' ', chars);
  return CORPUS.slice(0, cut > 0 ? cut : chars).trim();
}

async function synth(text: string): Promise<{ ms: number; seconds: number; chunks: SpokenAudioChunk[] }> {
  const started = Date.now();
  const chunks: SpokenAudioChunk[] = [];
  for await (const chunk of provider.synthesize({ text, voiceId: VOICE, speed: 1, hint: null })) {
    chunks.push(chunk);
  }
  const ms = Date.now() - started;
  const rate = chunks[0]?.sampleRate ?? 24_000;
  const samples = chunks.reduce((total, chunk) => total + chunk.samples.length, 0);
  return { ms, seconds: samples / rate, chunks };
}

const median = (values: number[]): number => {
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

// One throwaway call so the voice is loaded and the first row is not a cold start.
await synth('Warming up.');

const LENGTHS = [20, 40, 60, 80, 100, 140, 180, 220, 280, 340, 400, 480, 560];
const REPEATS = 3;

console.log(`endpoint ${baseUrl}  model ${model}  voice ${VOICE}  ${REPEATS} runs per length\n`);
console.log('chars   synth ms   audio s    rtf    ms/char   speech rate');

interface Row {
  readonly chars: number;
  readonly ms: number;
  readonly seconds: number;
}
const rows: Row[] = [];

for (const length of LENGTHS) {
  const text = prefix(length);
  const runs: number[] = [];
  let seconds = 0;
  for (let i = 0; i < REPEATS; i += 1) {
    const result = await synth(text);
    runs.push(result.ms);
    seconds = result.seconds;
  }
  const ms = median(runs);
  rows.push({ chars: text.length, ms, seconds });
  console.log(
    [
      String(text.length).padStart(5),
      String(Math.round(ms)).padStart(10),
      seconds.toFixed(2).padStart(9),
      (ms / 1000 / seconds).toFixed(3).padStart(7),
      (ms / text.length).toFixed(2).padStart(9),
      `${(text.length / seconds).toFixed(1)} chars/s`.padStart(14),
    ].join(''),
  );
}

/**
 * Least squares through (chars, ms). The intercept is what an extra chunk costs before it
 * has said anything, and the slope is what each character costs — which together decide
 * whether more, shorter chunks are cheap or expensive.
 */
const n = rows.length;
const sumX = rows.reduce((total, row) => total + row.chars, 0);
const sumY = rows.reduce((total, row) => total + row.ms, 0);
const sumXY = rows.reduce((total, row) => total + row.chars * row.ms, 0);
const sumXX = rows.reduce((total, row) => total + row.chars * row.chars, 0);
const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
const intercept = (sumY - slope * sumX) / n;

console.log(`\nfit: synth_ms ≈ ${intercept.toFixed(0)} + ${slope.toFixed(3)} × chars`);
console.log(`     per-request overhead ${intercept.toFixed(0)} ms, per character ${slope.toFixed(3)} ms`);

for (const budget of [245, 350, 500]) {
  const chars = Math.floor((budget - intercept) / slope);
  console.log(`     ${budget} ms budget → first chunk of at most ${chars} characters`);
}

const worst = rows.reduce((high, row) => Math.max(high, row.ms / 1000 / row.seconds), 0);
console.log(`     worst real-time factor across the sweep: ${worst.toFixed(3)} (must stay under 1)`);

// What the chunker actually does to a real answer at each candidate cap — the prosody
// half of the question, which no number settles.
console.log('\nwhat the chunker produces from one paragraph:');
for (const maxChars of [120, 200, 320]) {
  const chunks = chunkText(CORPUS, { maxChars });
  const lengths = chunks.map((chunk) => chunk.text.length);
  console.log(
    `  maxChars=${String(maxChars).padStart(3)}  ${String(chunks.length).padStart(2)} chunks  ` +
      `longest ${Math.max(...lengths)}  shortest ${Math.min(...lengths)}  ` +
      `first chunk: "${chunks[0]?.text.slice(0, 60) ?? ''}…"`,
  );
}

// The trade-off no number settles: a first chunk cut short gets audio out sooner and may
// sound like a fragment. These are the same opening at three first-chunk caps, so the
// decision can be made with ears.
const opening = chunkText(CORPUS, { maxChars: 200 })[0]?.text ?? '';
for (const cap of [34, 60, opening.length]) {
  const cut = cap >= opening.length ? opening : opening.slice(0, opening.lastIndexOf(' ', cap)).trim();
  const { chunks, ms } = await synth(cut);
  const rate = chunks[0]?.sampleRate ?? 24_000;
  const total = chunks.reduce((sum, chunk) => sum + chunk.samples.length, 0);
  const out = Buffer.alloc(44 + total * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + total * 2, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(total * 2, 40);
  let offset = 44;
  for (const chunk of chunks) {
    for (const value of chunk.samples) {
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), offset);
      offset += 2;
    }
  }
  writeFileSync(`live/out/opening-${cut.length}-chars.wav`, out);
  console.log(`  opening-${cut.length}-chars.wav — first audio after ${ms} ms — "${cut}"`);
}
