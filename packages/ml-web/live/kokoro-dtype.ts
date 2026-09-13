import { createRequire } from 'node:module';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { KOKORO_MODEL_ID, KOKORO_SAMPLE_RATE, type KokoroDtype } from '../src/kokoro/messages';

/**
 * Is `q8` good enough to be the default? (`docs/TASKS.md` C-5)
 *
 * `fp32` is the default only because Spike A measured it. The stake is 233 MB of first-run
 * download — 325 MB against 92 MB — which is the largest single cost of the browser TTS
 * path, so "close enough" would be worth a lot.
 *
 * The comparison needs no server. `kokoro-js` runs in node, so both graphs load in one
 * process and the same sentences are synthesised twice.
 *
 * **Two caveats, both load-bearing.**
 *
 * 1. This runs on **onnxruntime-node**, not WebGPU. Quantisation *error* is a property of
 *    the graph and carries over. Quantisation *speed* is not: a CPU provider dequantises
 *    int8 per operator, so the timings below say nothing about the browser.
 * 2. The two graphs predict their own phoneme durations, so the takes are **not
 *    sample-aligned** — they differ in length. Any sample-wise metric (SNR, correlation)
 *    is therefore meaningless here, however confident it looks. The measures below are
 *    alignment-free on purpose, and the WAVs in `live/out/` are the real answer.
 */

const VOICE = 'af_heart';

/**
 * transformers.js caches downloads next to its own package — `env.cacheDir` defaults to
 * `<transformers package>/.cache` and honours no environment variable — so the graphs land
 * inside `node_modules` and `pnpm install --force` would cost the 418 MB again. Acceptable
 * for a one-off comparison, and the reason this is a hand-run script and not a test.
 */
const CACHE = join(
  dirname(
    createRequire(createRequire(import.meta.url).resolve('kokoro-js')).resolve(
      '@huggingface/transformers',
    ),
  ),
  '..',
  '.cache',
);

/**
 * A dtype names a filename *suffix*, not a filename — `DEFAULT_DTYPE_SUFFIX_MAPPING` in
 * `@huggingface/transformers/src/utils/dtypes.js`. `q8` is `_quantized`; the repo's
 * `model_q8f16.onnx` is a different file that `q8` never fetches.
 */
const GRAPH_FILE: Readonly<Record<'fp32' | 'q8', string>> = {
  fp32: 'model.onnx',
  q8: 'model_quantized.onnx',
};

const SENTENCES: readonly (readonly [string, string])[] = [
  ['plain', 'The afternoon light came in low across the desk.'],
  // Sibilance and plosives are where quantisation noise is audible first.
  ['sibilant', 'She sells sixty-six shiny thistles; his sister just stopped asking.'],
  // Long held vowels, where a quantised graph can drift or buzz.
  ['tonal', 'Ohhh, I see, so you were waiting all along, were you?'],
];

/** Mono 16-bit WAV, for listening only. */
function toWav(samples: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
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
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), 44 + i * 2);
  }
  return out;
}

const FRAME = 480; // 20 ms at 24 kHz

interface Measures {
  readonly peak: number;
  readonly rms: number;
  /** RMS of the quietest tenth of frames — where quantisation hiss lives. */
  readonly floor: number;
  /** Zero crossings per second in those same quiet frames. Hiss raises it. */
  readonly quietZcr: number;
}

/**
 * Alignment-free measures. Quantisation damage shows up as a raised noise floor between
 * words and as high-frequency hiss inside it, neither of which needs the takes to line up.
 */
function measure(samples: Float32Array): Measures {
  let peak = 0;
  let energy = 0;
  for (const value of samples) {
    peak = Math.max(peak, Math.abs(value));
    energy += value * value;
  }

  const frames: { rms: number; zcr: number }[] = [];
  for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
    let frameEnergy = 0;
    let crossings = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const value = samples[start + i] ?? 0;
      frameEnergy += value * value;
      const previous = samples[start + i - 1] ?? 0;
      if (i > 0 && value < 0 !== previous < 0) crossings += 1;
    }
    frames.push({ rms: Math.sqrt(frameEnergy / FRAME), zcr: crossings });
  }
  frames.sort((a, b) => a.rms - b.rms);
  const quiet = frames.slice(0, Math.max(1, Math.round(frames.length / 10)));

  return {
    peak,
    rms: Math.sqrt(energy / Math.max(samples.length, 1)),
    floor: Math.sqrt(quiet.reduce((total, f) => total + f.rms * f.rms, 0) / quiet.length),
    quietZcr:
      (quiet.reduce((total, f) => total + f.zcr, 0) / quiet.length) * (KOKORO_SAMPLE_RATE / FRAME),
  };
}

const dB = (value: number): string => (value === 0 ? '-inf' : (20 * Math.log10(value)).toFixed(1));

interface Take extends Measures {
  readonly samples: number;
  readonly ms: number;
}

mkdirSync('live/out', { recursive: true });

const takes = new Map<string, Take>();
const DTYPES = ['fp32', 'q8'] as const satisfies readonly KokoroDtype[];

for (const dtype of DTYPES) {
  const loadStarted = Date.now();
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype, device: 'cpu' });
  const bytes = statSync(join(CACHE, KOKORO_MODEL_ID, 'onnx', GRAPH_FILE[dtype])).size;
  console.log(
    `\n=== ${dtype}  ${GRAPH_FILE[dtype]}, ${(bytes / 1e6).toFixed(1)} MB, ` +
      `loaded in ${Date.now() - loadStarted} ms`,
  );
  console.log('    sentence   synth ms   audio s    rtf     peak    rms dB   floor dB   quiet Hz');

  for (const [label, text] of SENTENCES) {
    const started = Date.now();
    const audio = await tts.generate(text, { voice: VOICE, speed: 1 });
    const ms = Date.now() - started;
    const samples = Float32Array.from(audio.audio);
    const rate = audio.sampling_rate;
    if (rate !== KOKORO_SAMPLE_RATE) {
      console.log(`    !! ${label} came back at ${rate} Hz, not ${KOKORO_SAMPLE_RATE}`);
    }
    const measures = measure(samples);
    takes.set(`${dtype}:${label}`, { ...measures, samples: samples.length, ms });
    writeFileSync(`live/out/${label}-${dtype}.wav`, toWav(samples, rate));
    const seconds = samples.length / rate;
    console.log(
      [
        `    ${label.padEnd(9)}`,
        String(ms).padStart(9),
        seconds.toFixed(2).padStart(10),
        (ms / 1000 / seconds).toFixed(2).padStart(7),
        measures.peak.toFixed(3).padStart(9),
        dB(measures.rms).padStart(10),
        dB(measures.floor).padStart(11),
        measures.quietZcr.toFixed(0).padStart(11),
      ].join(''),
    );
  }
}

console.log('\n=== q8 against fp32\n');
console.log('sentence   length delta   floor delta dB   quiet-hiss delta   synth speed');

for (const [label] of SENTENCES) {
  const reference = takes.get(`fp32:${label}`);
  const candidate = takes.get(`q8:${label}`);
  if (reference === undefined || candidate === undefined) continue;
  const driftMs = ((candidate.samples - reference.samples) / KOKORO_SAMPLE_RATE) * 1000;
  console.log(
    [
      label.padEnd(9),
      `${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(0)} ms`.padStart(15),
      (20 * Math.log10(candidate.floor / reference.floor)).toFixed(1).padStart(17),
      `${(candidate.quietZcr - reference.quietZcr).toFixed(0)} Hz`.padStart(19),
      `${(reference.ms / candidate.ms).toFixed(2)}x`.padStart(14),
    ].join(''),
  );
}

console.log(
  '\nLength delta is timing drift, not damage: the graphs predict their own durations.' +
    '\nFloor delta is the one to watch: a quantised graph hisses between words.' +
    '\nSynth speed is onnxruntime-node only and says nothing about WebGPU.' +
    '\n\nWAVs in packages/ml-web/live/out/ — <sentence>-fp32.wav against <sentence>-q8.wav.',
);
