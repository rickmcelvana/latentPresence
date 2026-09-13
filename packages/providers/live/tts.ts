import { writeFileSync } from 'node:fs';
import type { SpokenAudioChunk } from '@latentpresence/protocol';
import { OpenAICompatibleTTSProvider } from '@latentpresence/providers';

/**
 * The live TTS check (`docs/TASKS.md`).
 *
 * Proves `OpenAICompatibleTTSProvider` and `wav.ts` against a real server's bytes rather
 * than the hand-built fixtures the unit tests use — which is the half ADR-24 rests on.
 * Writes what it synthesised to `live/out/` so a human can listen to it.
 */

process.loadEnvFile('../../.env');

const baseUrl = process.env['TTS_BASE_URL'];
const model = process.env['TTS_MODEL'];
if (baseUrl === undefined || baseUrl === '' || model === undefined || model === '') {
  console.log('skip — TTS_BASE_URL / TTS_MODEL not set');
  process.exit(0);
}
const apiKey = process.env['TTS_API_KEY'];

const provider = new OpenAICompatibleTTSProvider({
  id: 'tts',
  baseUrl,
  model,
  ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
});

console.log(`endpoint: ${baseUrl}  model: ${model}\n`);

const capabilities = await provider.capabilities();
console.log('capabilities:', JSON.stringify(capabilities));

const voices = await provider.listVoices();
console.log(`voices:     ${voices.length} listed, first five: ${voices.slice(0, 5).map((v) => v.id).join(', ')}`);
const builtIn = new Set(['af_heart', 'af_bella', 'bm_fable']);
const extra = voices.filter((voice) => !voice.id.startsWith('af_') && !voice.id.startsWith('am_') && !voice.id.startsWith('bf_') && !voice.id.startsWith('bm_'));
console.log(`            ${[...builtIn].filter((id) => voices.some((v) => v.id === id)).length}/3 sampled kokoro-js ids present; ${extra.length} ids outside the a*/b* families\n`);


/** Mono 16-bit WAV from decoded samples. Only for listening to the result. */
function toWav(chunks: readonly SpokenAudioChunk[], rate: number): Buffer {
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
  return out;
}

/** One sentence, timed, decoded, and written out. */
async function say(
  label: string,
  text: string,
  voiceId: string,
  speed: number,
  mustFail = false,
): Promise<void> {
  const started = Date.now();
  const chunks: SpokenAudioChunk[] = [];
  try {
    for await (const chunk of provider.synthesize({ text, voiceId, speed, hint: null })) {
      chunks.push(chunk);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A request that was *supposed* to fail is a pass, and the message is the point: the
    // adapter must pass the server's own words through rather than flatten them.
    console.log(`${mustFail ? 'ok  ' : 'FAIL'}  ${label.padEnd(26)} | ${message.slice(0, 120)}…`);
    return;
  }
  const ms = Date.now() - started;
  const samples = chunks.reduce((total, chunk) => total + chunk.samples.length, 0);
  const rate = chunks[0]?.sampleRate ?? 0;
  const seconds = rate === 0 ? 0 : samples / rate;
  const finals = chunks.filter((chunk) => chunk.isFinal).length;
  const peak = chunks.reduce(
    (high, chunk) => chunk.samples.reduce((inner, value) => Math.max(inner, Math.abs(value)), high),
    0,
  );
  console.log(
    [
      finals === 1 && samples > 0 ? 'ok  ' : 'FAIL',
      label.padEnd(26),
      `chunks=${chunks.length}`,
      `final=${finals}`,
      `${rate}Hz`,
      `${seconds.toFixed(2)}s audio`,
      `in ${String(ms).padStart(5)}ms`,
      `peak=${peak.toFixed(3)}`,
      `rtf=${(ms / 1000 / Math.max(seconds, 0.001)).toFixed(2)}`,
    ].join('  '),
  );
  // Re-encode what *we* decoded, so playing this file proves the whole chain: the
  // server's bytes, wav.ts's parse, and the Float32 the pipeline would hand an
  // AudioWorklet. If this sounds right, the adapter is right.
  writeFileSync(`live/out/${label.replaceAll(/\W+/gu, '-')}.wav`, toWav(chunks, rate));
}

await say('short sentence', 'Hello there, this is a test.', 'af_heart', 1);
await say('long sentence', 'The quick brown fox jumps over the lazy dog, and then it does so again, rather more slowly this time.', 'af_heart', 1);
await say('other voice', 'Hello there, this is a test.', 'bm_fable', 1);
await say('unknown voice (must 400)', 'This should fail.', 'not_a_voice_at_all', 1, true);

/**
 * Where does `speed` stop being usable? Rick heard 1.5 "skip words" (2026-09-12), and a
 * provider that clamps to 0.25-4 implies the whole range works. Duration alone cannot
 * catch this — the server hits the requested ratio exactly while dropping phonemes — so
 * this also prints characters per second of *audio*, which rises past what the voice can
 * articulate, and writes each take out to be judged by ear.
 */
console.log('');
console.log('speed sweep — same sentence, listen for dropped words');
console.log('');
const SPEED_TEXT =
  'The afternoon light came in low across the desk and everything went the colour of weak tea.';
let baseline = 0;
for (const speed of [0.75, 1, 1.25, 1.5, 2, 3]) {
  const chunks: SpokenAudioChunk[] = [];
  for await (const chunk of provider.synthesize({
    text: SPEED_TEXT,
    voiceId: 'af_heart',
    speed,
    hint: null,
  })) {
    chunks.push(chunk);
  }
  const rate = chunks[0]?.sampleRate ?? 24_000;
  const seconds = chunks.reduce((total, chunk) => total + chunk.samples.length, 0) / rate;
  if (speed === 1) baseline = seconds;
  writeFileSync(`live/out/speed-${String(speed).replace('.', '-')}.wav`, toWav(chunks, rate));
  console.log(
    [
      `speed ${speed.toFixed(2)}`.padEnd(12),
      `${seconds.toFixed(2)}s`.padStart(8),
      // 1.00 means the server hit the requested ratio exactly.
      baseline === 0 ? '   -   ' : (baseline / seconds / speed).toFixed(3).padStart(8),
      `${(SPEED_TEXT.length / seconds).toFixed(1)} chars/s`.padStart(16),
    ].join('  '),
  );
}
