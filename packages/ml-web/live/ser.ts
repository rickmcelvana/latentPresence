import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimToVoice } from '@latentpresence/core';
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import * as ort from 'onnxruntime-web';
import { resample } from '../src/asr/resample';
import { KOKORO_MODEL_ID } from '../src/kokoro/messages';
import { BASE_LABELS, SER_MODELS, parseHead, serFileUrl, type SerModelKey } from '../src/ser/messages';
import { BaseSerModel, DistillSerModel, createSerSession, type SerModelLike } from '../src/ser/ser';

/**
 * The live voice-emotion check (P3-T05, `pnpm live:ser`), in node on onnxruntime-web's
 * wasm: do both models load from the pinned files, answer with sane probabilities, and how
 * long does a segment take on a CPU? The done-when's number — under 150 ms per segment *in a
 * worker* — is the browser's (`/dev/voice`'s SER panel); this is the floor and the sanity.
 *
 * The speech is Kokoro's, which has no emotion at all, so the right answer for every clip
 * is `neutral`; a model that hears joy in it is telling us about itself. Files are fetched
 * once into the gitignored `live/out/models` and size-checked against the catalog.
 */

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(join(out, 'models'), { recursive: true });

async function fileBytes(key: SerModelKey, index: number): Promise<Uint8Array> {
  const spec = SER_MODELS[key];
  const file = spec.files[index];
  if (file === undefined) throw new Error(`${key} has no file ${index}`);
  const path = join(out, 'models', `${spec.repo.replaceAll('/', '_')}_${spec.revision.slice(0, 7)}_${file.file}`);
  if (!existsSync(path)) {
    console.log(`fetching ${file.file} (${(file.bytes / 1e6).toFixed(1)} MB)…`);
    const response = await fetch(serFileUrl(key, file));
    if (!response.ok) throw new Error(`${file.file}: HTTP ${response.status}`);
    writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.length !== file.bytes) throw new Error(`${file.file}: ${bytes.length} bytes, catalog says ${file.bytes}`);
  return bytes;
}

const SENTENCES = [
  'Oh.',
  'Honestly, I was not sure you would come back today.',
  'The afternoon light came in low across the desk, and it caught the dust in the air while we talked about nothing.',
];

const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8', device: 'cpu' });
async function speak(text: string): Promise<Float32Array> {
  const input = new TextSplitterStream();
  input.push(text);
  input.close();
  const parts: Float32Array[] = [];
  for await (const part of tts.stream(input, { voice: 'af_heart' })) parts.push(part.audio.audio);
  const whole = Float32Array.from(parts.flatMap((part) => Array.from(part)));
  return resample(trimToVoice(whole, 24_000, { leadMs: 0, tailMs: 0 }).samples, 24_000, 16_000);
}
const clips = await Promise.all(SENTENCES.map(speak));

ort.env.wasm.numThreads = 1;
const models: [SerModelKey, SerModelLike][] = [
  ['distill', new DistillSerModel(await createSerSession(await fileBytes('distill', 0), 'wasm'))],
  [
    'base',
    new BaseSerModel(
      (await createSerSession(await fileBytes('base', 0), 'wasm')) as unknown as ConstructorParameters<typeof BaseSerModel>[0],
      parseHead(JSON.parse(new TextDecoder().decode(await fileBytes('base', 1)))),
    ),
  ],
];

const lines: string[] = [`# live:ser — ${new Date().toISOString()}`, '', 'onnxruntime-web wasm in node, 1 thread. Kokoro af_heart, so every clip should read neutral.', '', '| model | clip | heard | run ms (median of 5, after 1 warm-up) | top | p(top) | p(neutral) |', '|---|---|---|---|---|---|---|'];
for (const [key, model] of models) {
  await model.classify(clips[0] ?? new Float32Array(16_000));
  for (const [i, clip] of clips.entries()) {
    const runs: number[] = [];
    let last = await model.classify(clip);
    for (let r = 0; r < 5; r += 1) {
      last = await model.classify(clip);
      runs.push(last.inferenceMs);
    }
    runs.sort((a, b) => a - b);
    const top = last.probabilities.indexOf(Math.max(...last.probabilities));
    const line = `| ${key} | ${i + 1} (${(clip.length / 16_000).toFixed(1)} s) | ${last.seconds.toFixed(1)} s | ${Math.round(runs[2] ?? 0)} | ${BASE_LABELS[top]} | ${(last.probabilities[top] ?? 0).toFixed(2)} | ${(last.probabilities[4] ?? 0).toFixed(2)} |`;
    lines.push(line);
    console.log(line);
  }
}
writeFileSync(join(out, 'ser.md'), `${lines.join('\n')}\n`);
console.log('\nwrote live/out/ser.md');
