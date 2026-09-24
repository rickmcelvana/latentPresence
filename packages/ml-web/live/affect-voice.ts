import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawAudio } from '@huggingface/transformers';
import { styledSpeed, trimToVoice, voicedRange, type VoiceStyle } from '@latentpresence/core';
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import { KOKORO_MODEL_ID } from '../src/kokoro/messages';

/**
 * The live mood check's ears (P3-T03, `pnpm live:affect-voice`), after `pnpm live:affect`.
 *
 * Kokoro has no emotion control, so what a mood changes in her voice is **ours**: the pace
 * (`styledSpeed`) and the silence after each sentence (`VoiceStyle.pauseMs`, in place of
 * ADR-27's 250 ms tail). This renders each reply sentence by sentence exactly as `Reply`
 * does — synthesise at the styled speed, trim to the voice plus the styled padding, queue —
 * and writes two sets of files to `live/out/affect/`:
 *
 * - `<n>-<mood>.wav`: each mood's own reply, so wording and voice are heard together;
 * - `<n>-same-<mood>.wav`: **the rest reply's text in every mood**, so the voice alone is
 *   what differs — the half of the done-when that wording cannot carry.
 *
 * It reports each file's length, the voiced words per second and the pauses, measured on
 * the audio rather than read back from the style. Hand-run; `AFFECT_VOICE_TARGET=fable`
 * picks the target (default: the first in the file).
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', 'providers', 'live', 'out', 'affect.json');
const out = join(here, 'out', 'affect');
mkdirSync(out, { recursive: true });

if (!existsSync(source)) throw new Error('run `pnpm live:affect` first: no providers/live/out/affect.json');

interface Row {
  readonly mood: string;
  readonly prompt: string;
  readonly words: number;
  readonly sentences: readonly { readonly text: string; readonly style: VoiceStyle }[];
}

const all = JSON.parse(readFileSync(source, 'utf8')) as Record<string, Row[]>;
const target = process.env['AFFECT_VOICE_TARGET'] ?? Object.keys(all)[0];
const rows = target === undefined ? undefined : all[target];
if (target === undefined || rows === undefined) throw new Error(`no replies for ${target ?? 'any target'} in affect.json`);

const RATE = 24_000;
const VOICE = 'af_heart';
const BASE_SPEED = 1;
const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8', device: 'cpu' });

async function synth(text: string, speed: number): Promise<Float32Array> {
  const input = new TextSplitterStream();
  input.push(text);
  input.close();
  const parts: Float32Array[] = [];
  for await (const part of tts.stream(input, { voice: VOICE, speed })) parts.push(part.audio.audio);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const whole = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

/** One reply as `Reply` queues it; returns the audio and the silences between voices. */
async function render(sentences: readonly { readonly text: string }[], style: VoiceStyle) {
  const clips: Float32Array[] = [];
  let voiced = 0;
  for (const { text } of sentences) {
    const raw = await synth(text, styledSpeed(BASE_SPEED, style));
    const trimmed = trimToVoice(raw, RATE, { leadMs: 50, tailMs: style.pauseMs });
    clips.push(trimmed.samples);
    voiced += trimmed.voicedEnd - trimmed.voicedStart;
  }
  const total = clips.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let at = 0;
  const gaps: number[] = [];
  let lastEnd: number | null = null;
  for (const clip of clips) {
    samples.set(clip, at);
    const range = voicedRange(clip);
    if (lastEnd !== null) gaps.push(at + range.start - lastEnd);
    lastEnd = at + range.end;
    at += clip.length;
  }
  return { samples, voicedSeconds: voiced / RATE, gapsMs: gaps.map((g) => Math.round((g / RATE) * 1000)) };
}

const words = (sentences: readonly { readonly text: string }[]): number =>
  sentences.reduce((n, s) => n + s.text.split(/\s+/u).filter(Boolean).length, 0);
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

const md: string[] = [
  `# live:affect-voice — ${new Date().toISOString()}`,
  '',
  `Target \`${target}\`, voice \`${VOICE}\`, Kokoro q8 on CPU. Files in \`packages/ml-web/live/out/affect/\`.`,
  '',
  '| file | mood | speed | length | words/s voiced | gaps between sentences (ms) |',
  '|---|---|---|---|---|---|',
];
const prompts = [...new Set(rows.map((row) => row.prompt))];
for (const [n, prompt] of prompts.entries()) {
  const mine = rows.filter((row) => row.prompt === prompt);
  const rest = mine.find((row) => row.mood === 'rest');
  for (const row of mine) {
    const style = row.sentences[0]?.style;
    if (style === undefined) continue;
    const own = await render(row.sentences, style);
    const name = `${n + 1}-${row.mood}.wav`;
    await new RawAudio(own.samples, RATE).save(join(out, name));
    const line = (file: string, r: typeof own, count: number) =>
      `| ${file} | ${row.mood} | ${styledSpeed(BASE_SPEED, style).toFixed(3)} | ${(r.samples.length / RATE).toFixed(2)} s | ${(count / r.voicedSeconds).toFixed(2)} | ${r.gapsMs.join(', ') || '—'} (median ${median(r.gapsMs) ?? '—'}) |`;
    md.push(line(name, own, words(row.sentences)));
    if (rest !== undefined) {
      const same = await render(rest.sentences, style);
      const sameName = `${n + 1}-same-${row.mood}.wav`;
      await new RawAudio(same.samples, RATE).save(join(out, sameName));
      md.push(line(sameName, same, words(rest.sentences)));
    }
    console.log(md.at(-1));
  }
}

writeFileSync(join(here, 'out', 'affect-voice.md'), `${md.join('\n')}\n`);
console.log(`\nwrote live/out/affect-voice.md and ${out}`);
