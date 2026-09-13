import { createRequire } from 'node:module';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pipeline } from '@huggingface/transformers';

/**
 * What does an ASR model actually cost to download? (`docs/SURFACE.md`)
 *
 * The consent screen (ADR-09) quotes a size before anything is fetched, so the number has
 * to be the real one. It cannot be read off a Hugging Face file listing: a repo holds
 * every quantisation and several tokenizer formats, and transformers.js fetches two graphs
 * (`encoder_model` + `decoder_model_merged`) and only some of the JSON. Guessing which
 * JSON is how `KOKORO_BYTES.q8` came to understate a download by 6.3 MB.
 *
 * So this downloads into an empty cache and reports what landed. Run once per model; the
 * non-graph bytes are the same at every dtype, so the other rows are that plus the graph
 * sizes from the blob listing.
 *
 *   pnpm --filter @latentpresence/ml-web exec vite-node live/asr-download.ts <model> <dtype>
 */

const CACHE = join(
  dirname(createRequire(import.meta.url).resolve('@huggingface/transformers')),
  '..',
  '.cache',
);

const modelId = process.argv[2] ?? 'onnx-community/moonshine-tiny-ONNX';
const dtype = process.argv[3] ?? 'q8';

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

const before = new Set(
  (() => {
    try {
      return walk(join(CACHE, modelId));
    } catch {
      return [];
    }
  })(),
);

console.log(`${modelId} @ ${dtype}`);
const started = Date.now();
// Same call the worker makes. `pipeline` is overloaded across every task transformers
// supports and resolving those overloads with an options object produces a union
// TypeScript refuses to represent (TS2590) -- the cast is Spike A's, for the same reason.
const build = pipeline as unknown as (
  task: 'automatic-speech-recognition',
  model: string,
  options: Record<string, unknown>,
) => Promise<unknown>;
await build('automatic-speech-recognition', modelId, { device: 'cpu', dtype });
console.log(`loaded in ${Date.now() - started} ms\n`);

let graphs = 0;
let rest = 0;
for (const path of walk(join(CACHE, modelId))) {
  const size = statSync(path).size;
  if (path.endsWith('.onnx') || path.endsWith('.onnx_data')) graphs += size;
  else rest += size;
  console.log(
    `${before.has(path) ? ' ' : '+'} ${String(size).padStart(11)}  ${relative(CACHE, path)}`,
  );
}

console.log(`\n  graphs        ${String(graphs).padStart(11)}`);
console.log(`  everything else ${String(rest).padStart(9)}   <- dtype-independent`);
console.log(`  total         ${String(graphs + rest).padStart(11)}  (${((graphs + rest) / 1e6).toFixed(1)} MB)`);
