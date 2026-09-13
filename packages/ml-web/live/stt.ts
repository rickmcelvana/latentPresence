import { pipeline } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { KOKORO_MODEL_ID } from '../src/kokoro/messages';
import { ASR_MODELS, ASR_SAMPLE_RATE, type AsrModelKey } from '../src/asr/messages';
import { resample } from '../src/asr/resample';

/**
 * The live recognition check (`docs/TASKS.md`).
 *
 * A closed loop: **Kokoro says a known sentence and the recognisers write it down.** No
 * microphone, no fixture, no human — the reference text is the text that was spoken, so
 * word error rate is computable rather than eyeballed, and the whole chain that P1-T06
 * added gets exercised on real audio: `resample()` from Kokoro's 24 kHz to the models'
 * 16 kHz, then the same pipeline options `asr.worker.ts` sends.
 *
 * The worker itself cannot run here — it is a browser worker — so what this proves is the
 * half that is model behaviour rather than message passing. The message passing is what
 * `browser-stt.test.ts` covers against a fake port.
 *
 * Both the checks below exist because a comment in `asr.worker.ts` claims something:
 *
 * - that handing a model unresampled audio is silently wrong rather than an error;
 * - that Moonshine's own token budget floors to zero under one second, so "Yes." comes
 *   back empty without the floor the worker adds.
 *
 * A claim in a comment that nothing runs is a guess with better formatting.
 */

const SENTENCES = [
  'The afternoon light came in low across the desk.',
  'She had been talking for a while by then, about the house she grew up in.',
] as const;

/** Under a second once trimmed, which is where Moonshine's heuristic budget collapses. */
const SHORT = 'Yes.';

/**
 * Drop leading and trailing near-silence, the way a VAD hands an utterance over.
 * Kokoro pads "Yes." out to 1.35 s, which is long enough to hide the very trap this is
 * meant to show — the untrimmed clip clears Moonshine's one-second floor by accident.
 */
function trim(samples: Float32Array, threshold = 0.01): Float32Array {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start] ?? 0) < threshold) start += 1;
  while (end > start && Math.abs(samples[end - 1] ?? 0) < threshold) end -= 1;
  return samples.slice(start, end);
}

const MODELS: readonly AsrModelKey[] = ['moonshine-tiny', 'whisper-base'];
const DTYPE = 'q8'; // What is cached on this box. On WebGPU this would be refused (ADR-20).

interface Recogniser {
  (
    audio: Float32Array,
    options: Record<string, unknown>,
  ): Promise<{ text?: string; chunks?: { text?: string; timestamp?: readonly (number | null)[] }[] }>;
}

const build = pipeline as unknown as (
  task: 'automatic-speech-recognition',
  model: string,
  options: Record<string, unknown>,
) => Promise<Recogniser>;

/** Strip punctuation and case, which no recogniser agrees on and no consumer depends on. */
const normalise = (text: string): string[] =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s']/gu, '')
    .split(/\s+/u)
    .filter((word) => word !== '');

/** Levenshtein over words, divided by the reference length: the standard WER. */
function wordErrorRate(reference: string, hypothesis: string): number {
  const a = normalise(reference);
  const b = normalise(hypothesis);
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return (previous[b.length] ?? 0) / a.length;
}

console.log(`speaking with Kokoro, listening with ${MODELS.join(' and ')} @ ${DTYPE}\n`);

const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8', device: 'cpu' });

/** Kokoro's 24 kHz output, converted to what the recognisers expect. */
async function speak(text: string): Promise<{ at24k: Float32Array; at16k: Float32Array }> {
  const audio = await tts.generate(text, { voice: 'af_heart', speed: 1 });
  const at24k = Float32Array.from(audio.audio);
  return { at24k, at16k: resample(at24k, audio.sampling_rate, ASR_SAMPLE_RATE) };
}

const spoken = await Promise.all(SENTENCES.map(speak));
const shortSpoken = await speak(SHORT);
const short = trim(shortSpoken.at16k);

for (const model of MODELS) {
  const spec = ASR_MODELS[model];
  const started = Date.now();
  const recognise = await build('automatic-speech-recognition', spec.modelId, {
    device: 'cpu',
    dtype: DTYPE,
  });
  console.log(`=== ${model}  (loaded in ${Date.now() - started} ms)`);

  /** Exactly the options `asr.worker.ts` builds — no `max_new_tokens`, deliberately. */
  const options = (): Record<string, unknown> =>
    spec.wordTimestamps ? { return_timestamps: 'word' } : {};

  for (const [index, sentence] of SENTENCES.entries()) {
    const audio = spoken[index];
    if (audio === undefined) continue;
    const seconds = audio.at16k.length / ASR_SAMPLE_RATE;

    const heardAt = Date.now();
    const output = await recognise(audio.at16k, options());
    const ms = Date.now() - heardAt;
    const text = (output.text ?? '').trim();
    const wer = wordErrorRate(sentence, text);
    const words = output.chunks?.length ?? 0;
    console.log(
      `  ${wer === 0 ? 'exact' : wer < 0.15 ? 'ok   ' : 'POOR '} ` +
        `wer ${(wer * 100).toFixed(0).padStart(3)}%  ${String(ms).padStart(5)} ms  ` +
        `rtf ${(ms / 1000 / seconds).toFixed(2)}  ${words} word times  | ${text}`,
    );

    // The claim being tested: skipping the conversion is not an error, it is a wrong
    // answer with no warning. Two source rates, because how wrong it gets depends on how
    // far off the rate is — 24 kHz is 1.5x and a browser microphone is usually 48 kHz, 3x.
    if (index === 0) {
      for (const [rate, unconverted] of [
        [24_000, audio.at24k],
        [48_000, resample(audio.at24k, 24_000, 48_000)],
      ] as const) {
        const heard = (
          await recognise(unconverted, options())
        ).text?.trim();
        console.log(
          `        unconverted ${rate} Hz read as 16 kHz (${(rate / ASR_SAMPLE_RATE).toFixed(1)}x): ` +
            `wer ${(wordErrorRate(sentence, heard ?? '') * 100).toFixed(0).padStart(3)}%  | ${heard}`,
        );
      }
    }
  }

  // The claim that was tested and turned out false: that `_call_moonshine`'s
  // `Math.floor(seconds) * 6` budget, which really is 0 below a second, loses short
  // utterances. It does not, and forcing a floor of 24 made Moonshine answer
  // "Yes, yes, yes." instead. Kept as a regression check on both halves.
  const shortSeconds = short.length / ASR_SAMPLE_RATE;
  const withFloor = (await recognise(short, options())).text?.trim();
  const budget = Math.floor(shortSeconds) * 6;
  const withoutFloor = (await recognise(short, { max_new_tokens: budget })).text?.trim();
  console.log(
    `  "${SHORT}" trimmed to ${shortSeconds.toFixed(2)} s (the model's own budget: ` +
      `${budget} tokens) -- as the worker sends it: "${withFloor}"  |  forced to that budget: "${withoutFloor}"`,
  );
  console.log('');
}
