import { writeFileSync, mkdirSync } from 'node:fs';
import { KokoroTTS } from 'kokoro-js';

/**
 * Regenerates `e2e/fixtures/speech.wav`, the audio Chrome plays into P1-T14's fake
 * microphone (`--use-file-for-fake-audio-capture`).
 *
 * **Run by hand, never by the gate or the e2e suite.** It needs Kokoro's 325 MB, which is
 * exactly why the fixture is committed rather than generated on the fly: the point of the
 * end-to-end test is that CI downloads nothing bigger than Silero's 2.2 MB.
 *
 * ```bash
 * pnpm e2e:fixture
 * ```
 *
 * **Why real speech rather than a tone.** Chrome's built-in fake device does make Silero
 * fire, but **once, at the start of the stream** — measured over 30 s: one
 * `user.speech.started` and no more (`docs/SURFACE.md`). One burst is a turn; a barge-in
 * needs the microphone to speak *again* while the character is answering. So this is two
 * utterances with a gap: the first ends on the hangover, and the next one lands during the
 * answer. Chrome loops the file, so the pattern repeats for as long as the test runs.
 *
 * The result is our own synthesis from an Apache-2.0 model — not a downloaded asset and not
 * a weight — and small enough to commit, which is what keeps the test hermetic.
 */

const SENTENCE = 'What time is it, and is it still raining outside?';
const RATE = 16_000;
/** Silence after each utterance. Comfortably past the 512 ms hangover, so a turn really ends. */
const GAP_MS = 1400;

function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, samples.length - 1);
    const t = at - low;
    out[i] = (samples[low] ?? 0) * (1 - t) + (samples[high] ?? 0) * t;
  }
  return out;
}

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

const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32' });
const spoken = await tts.generate(SENTENCE, { voice: 'am_michael' });
const voice = resample(Float32Array.from(spoken.audio), spoken.sampling_rate, RATE);
const gap = new Float32Array(Math.round((GAP_MS / 1000) * RATE));

// Two utterances, so one loop gives a turn to answer and something to interrupt it with.
const total = new Float32Array((voice.length + gap.length) * 2);
total.set(voice, 0);
total.set(voice, voice.length + gap.length);

const target = new URL('../../../e2e/fixtures/', import.meta.url);
mkdirSync(target, { recursive: true });
writeFileSync(new URL('speech.wav', target), toWav(total, RATE));
console.log(`wrote e2e/fixtures/speech.wav: ${(total.length / RATE).toFixed(2)} s at ${RATE} Hz`);
