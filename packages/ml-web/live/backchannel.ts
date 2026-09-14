import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, RawAudio } from '@huggingface/transformers';
import { BACKCHANNEL_PADDING, DEFAULT_BACKCHANNEL_PHRASES, trimToVoice, voicedRange } from '@latentpresence/core';
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import { ASR_MODELS } from '../src/asr/messages';
import { resample } from '../src/asr/resample';
import { KOKORO_MODEL_ID } from '../src/kokoro/messages';

/**
 * The live backchannel check (P1-T09, `pnpm live:backchannel`): what does Kokoro actually say?
 *
 * A backchannel is a word or a noise with no sentence around it, and Kokoro reads text
 * through a phonemizer, so the question is not whether synthesis works but what it is
 * asked to pronounce. For every candidate, on two voices: **the phonemes kokoro-js
 * produced**, the voiced length (a clip starts ~160 ms into a pause and the hangover ends
 * the turn at 512 ms, so length decides whether it is heard whole — ADR-28), the length
 * after `BACKCHANNEL_PADDING`, and what Whisper hears. Whisper is a weak judge of "mm-hm"
 * and a good one of "right", so the phonemes are the evidence and Whisper the cross-check.
 *
 * Every rendering is written to `live/out/backchannel/` for an ear.
 *
 * **`tts.stream(text)` with a string never finishes in kokoro-js 1.2.1**: it builds a
 * `TextSplitterStream`, pushes the text and never closes it, so the loop waits forever and
 * node exits 0 with nothing printed. Pass a closed stream, as `kokoro.worker.ts` does.
 */

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out', 'backchannel');
mkdirSync(out, { recursive: true });

const RATE = 24_000;
const VOICES = ['af_heart', 'am_michael'] as const;
/** Nonverbal spellings, tried and rejected: each is here so the reason stays reproducible. */
const REJECTED = ['Mm-hmm.', 'Mhm.', 'Mm.', 'Hmm.', 'Uh-huh.', 'Uh huh.'];
const WORDS = [...DEFAULT_BACKCHANNEL_PHRASES, 'Sure.', 'Okay.', 'I see.'];

const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8', device: 'cpu' });
const build = pipeline as unknown as (
  task: 'automatic-speech-recognition',
  model: string,
  options: Record<string, unknown>,
) => Promise<(audio: Float32Array) => Promise<{ text?: string }>>;
const whisper = await build('automatic-speech-recognition', ASR_MODELS['whisper-base'].modelId, { device: 'cpu', dtype: 'q8' });

const ms = (frames: number): string => String(Math.round((frames / RATE) * 1000)).padStart(4);

for (const voice of VOICES) {
  console.log(`\n=== ${voice}`);
  console.log('phrase    default  phonemes                  voiced  clip  whisper');
  for (const phrase of new Set([...WORDS, ...REJECTED])) {
    const input = new TextSplitterStream();
    input.push(phrase);
    input.close();
    let phonemes = '';
    const parts: Float32Array[] = [];
    for await (const part of tts.stream(input, { voice })) {
      phonemes += part.phonemes;
      parts.push(part.audio.audio);
    }
    const samples = Float32Array.from(parts.flatMap((part) => Array.from(part)));
    const { start, end } = voicedRange(samples);
    const clip = trimToVoice(samples, RATE, BACKCHANNEL_PADDING).samples;
    const heard = (await whisper(resample(samples, RATE, 16_000))).text?.trim() ?? '';
    await new RawAudio(clip, RATE).save(join(out, `${voice}-${phrase.replaceAll(/[^A-Za-z]/gu, '')}.wav`));
    const isDefault = DEFAULT_BACKCHANNEL_PHRASES.includes(phrase) ? 'yes' : REJECTED.includes(phrase) ? 'no' : '';
    console.log(
      `${phrase.padEnd(9)} ${isDefault.padEnd(8)} ${`/${phonemes}/`.padEnd(25)} ${ms(end - start)}  ${ms(clip.length)}  ${heard}`,
    );
  }
}
console.log(`\nclips written to ${out}`);
