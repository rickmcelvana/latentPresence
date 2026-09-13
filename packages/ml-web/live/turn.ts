import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';
import { TurnDetector, type TurnEvent, type TurnJudge } from '@latentpresence/core';
import type { CancellationSignal } from '@latentpresence/protocol';
import { KokoroTTS } from 'kokoro-js';
import { ASR_MODELS, moonshineTokenBudget } from '../src/asr/messages';
import { resample } from '../src/asr/resample';
import { KOKORO_MODEL_ID } from '../src/kokoro/messages';
import {
  SILERO_VAD,
  SMART_TURN,
  TURN_MODEL_SAMPLE_RATE,
  VAD_FRAME_SAMPLES,
  modelUrl,
  type SmartTurnBuild,
} from '../src/turn/messages';
import { SileroVad, createSileroSession } from '../src/turn/silero';
import { SmartTurnModel, createSmartTurnSession } from '../src/turn/smart-turn';

/**
 * The live turn-detection check (P1-T07, `docs/TASKS.md`).
 *
 * The done-when asks for recorded audio fixtures, and this repo does not grow binaries.
 * So, the closed loop P1-T06 built: **Kokoro speaks each utterance and the labelled end
 * of speech is where the synthesis ended** — exact, rather than hand-marked. Then the
 * shipped code endpoints it: `SileroVad` and `SmartTurnModel` from `src/turn`, the same
 * modules the workers load, feeding the real `TurnDetector` from `packages/core`.
 *
 * **Time is virtual, and says so.** Frames are fed as fast as they compute; a judge
 * answer is delivered when the *audio clock* reaches the moment it was asked plus a
 * stated latency. Two latencies are reported: the one measured on this machine (node,
 * wasm, single thread) and Spike D's browser WebGPU figure. Real-time pacing would
 * measure this box's CPU and call it endpointing.
 *
 * The brief's caveat is checked rather than assumed: **Kokoro's output has no room tone
 * or breath**, so every utterance runs twice — over digital silence and over a noise
 * floor — and Silero runs both with and without the reference's 64-sample context.
 */

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(join(out, 'models'), { recursive: true });

/** Spike D, fp32/WebGPU: from the candidate cut to the answer — 22 ms log-mel, 14 ms graph, scheduling. */
const WEBGPU_ANSWER_MS = 40;
const LEAD_MS = 600;
const TAIL_MS = 1500;
/** −46 dBFS white noise. A quiet room through a desk microphone, not a loud one. */
const NOISE_RMS = 0.005;

interface Line {
  readonly text: string;
  readonly complete: boolean;
}

/** Labelled before anything is spoken, as Spike D did. Six each. */
const SCRIPT: readonly Line[] = [
  { text: 'The afternoon light came in low across the desk.', complete: true },
  { text: 'Can you remind me what time the train leaves tomorrow?', complete: true },
  { text: 'I think we should paint the kitchen a darker green.', complete: true },
  { text: 'That was the best meal I have had in years.', complete: true },
  { text: 'Yes.', complete: true },
  { text: 'Could you turn the music down a little?', complete: true },
  { text: 'I was thinking that maybe we could', complete: false },
  { text: 'The thing about the old house is that', complete: false },
  { text: 'So when I got to the station, the', complete: false },
  { text: 'What I really wanted to ask you was', complete: false },
  { text: 'If the weather holds up tomorrow and', complete: false },
  { text: 'My sister said she would call, but', complete: false },
];

/** Fetched once into the gitignored `live/out/models`, and the size checked against the catalog. */
async function modelBytes(spec: { file: string; bytes: number; repo: string; revision: string }): Promise<Uint8Array> {
  const path = join(out, 'models', `${spec.repo.replaceAll('/', '_')}_${spec.revision.slice(0, 7)}_${spec.file.replaceAll('/', '_')}`);
  if (!existsSync(path)) {
    const response = await fetch(modelUrl(spec));
    if (!response.ok) throw new Error(`${modelUrl(spec)}: HTTP ${response.status}`);
    writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.length !== spec.bytes) {
    throw new Error(`${spec.file}: downloaded ${bytes.length} bytes, catalog says ${spec.bytes}`);
  }
  return bytes;
}

function trim(samples: Float32Array, threshold = 0.01): Float32Array {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start] ?? 0) < threshold) start += 1;
  while (end > start && Math.abs(samples[end - 1] ?? 0) < threshold) end -= 1;
  return samples.slice(start, end);
}

/** Deterministic noise, so a rerun hears the same room. */
function noise(length: number, rms: number, seed: number): Float32Array {
  let state = seed >>> 0 || 1;
  const buffer = new Float32Array(length);
  // Uniform in [-a, a] has rms a/sqrt(3).
  const amplitude = rms * Math.sqrt(3);
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[i] = ((state >>> 0) / 0xffffffff * 2 - 1) * amplitude;
  }
  return buffer;
}

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? Number.NaN : sorted.length % 2 === 1 ? (sorted[mid] ?? Number.NaN) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const normalise = (text: string): string[] =>
  text.toLowerCase().replaceAll(/[^a-z0-9\s']/gu, '').split(/\s+/u).filter((word) => word !== '');

function wordErrorRate(reference: string, hypothesis: string): number {
  const a = normalise(reference);
  const b = normalise(hypothesis);
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1));
    }
    previous = current;
  }
  return (previous[b.length] ?? 0) / a.length;
}

// ---------------------------------------------------------------------------------------
// Load everything first, so no load time lands inside a measurement.

console.log('loading Kokoro (q8, cpu), Silero, Smart Turn fp32 + int8 (wasm), Moonshine tiny (q8, cpu)\n');
const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8', device: 'cpu' });
const sileroBytes = await modelBytes(SILERO_VAD);
const turnModels: Record<SmartTurnBuild, SmartTurnModel> = {
  gpu: new SmartTurnModel(await createSmartTurnSession(await modelBytes(SMART_TURN.gpu), 'wasm')),
  cpu: new SmartTurnModel(await createSmartTurnSession(await modelBytes(SMART_TURN.cpu), 'wasm')),
};
const build = pipeline as unknown as (
  task: 'automatic-speech-recognition',
  model: string,
  options: Record<string, unknown>,
) => Promise<(audio: Float32Array, options: Record<string, unknown>) => Promise<{ text?: string }>>;
const moonshine = await build('automatic-speech-recognition', ASR_MODELS['moonshine-tiny'].modelId, {
  device: 'cpu',
  dtype: 'q8',
});
console.log(`sizes match the catalog: Silero ${SILERO_VAD.bytes}, Smart Turn fp32 ${SMART_TURN.gpu.bytes}, int8 ${SMART_TURN.cpu.bytes}\n`);

// ---------------------------------------------------------------------------------------
// Speak the script once. Resampled once, 24 kHz to 16 kHz, and every consumer reads that.

interface Spoken extends Line {
  readonly speech: Float32Array;
}
const spoken: Spoken[] = [];
for (const line of SCRIPT) {
  const audio = await tts.generate(line.text, { voice: 'af_heart', speed: 1 });
  const at16k = resample(Float32Array.from(audio.audio), audio.sampling_rate, TURN_MODEL_SAMPLE_RATE);
  spoken.push({ ...line, speech: trim(at16k) });
}

// ---------------------------------------------------------------------------------------

type Condition = 'silence' | 'noise';

/** A judge that runs the real model now and answers when the audio clock says it would have. */
class VirtualJudge implements TurnJudge {
  readonly due: { at: number; deliver: () => void }[] = [];
  readonly working: Promise<void>[] = [];
  readonly measuredMs: number[] = [];
  readonly probabilities: number[] = [];
  private readonly model: SmartTurnModel;
  private readonly latency: 'measured' | number;
  private readonly clock: { now: number };

  constructor(model: SmartTurnModel, latency: 'measured' | number, clock: { now: number }) {
    this.model = model;
    this.latency = latency;
    this.clock = clock;
  }

  judge(audio: Float32Array, _signal: CancellationSignal): Promise<number> {
    const askedAt = this.clock.now;
    return new Promise<number>((resolve, reject) => {
      const work = this.model.judge(audio).then(
        (result) => {
          const cost = result.featuresMs + result.inferenceMs;
          this.measuredMs.push(cost);
          this.probabilities.push(result.probability);
          const delay = this.latency === 'measured' ? cost : this.latency;
          this.due.push({ at: askedAt + delay, deliver: () => resolve(result.probability) });
        },
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
      this.working.push(work);
    });
  }
}

interface Run {
  readonly events: TurnEvent<null>[];
  readonly probabilities: number[];
  readonly measuredMs: number[];
  readonly sileroMs: number[];
  readonly frameProbabilities: number[];
  readonly cancelled: number;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function endpoint(
  stream: Float32Array,
  options: { latency: 'measured' | number; context: boolean; build: SmartTurnBuild },
): Promise<Run> {
  const clock = { now: 0 };
  const judge = new VirtualJudge(turnModels[options.build], options.latency, clock);
  const vad = new SileroVad(await createSileroSession(sileroBytes), { context: options.context });
  let cancelled = 0;
  const detector = new TurnDetector<null>({
    now: () => clock.now,
    judge,
    recognise: (_audio, signal) => {
      signal.addEventListener('abort', () => {
        cancelled += 1;
      });
      return null;
    },
  });
  const events: TurnEvent<null>[] = [];
  detector.subscribe((event) => events.push(event));
  const sileroMs: number[] = [];
  const frameProbabilities: number[] = [];

  for (let index = 0; index + VAD_FRAME_SAMPLES <= stream.length; index += VAD_FRAME_SAMPLES) {
    const at = (index / TURN_MODEL_SAMPLE_RATE) * 1000;
    // Let every judgement that has been asked finish computing, then deliver the ones
    // whose answer time the audio has now reached — before this frame, as it would be.
    await Promise.all(judge.working);
    judge.due.sort((a, b) => a.at - b.at);
    while ((judge.due[0]?.at ?? Infinity) <= at) {
      const next = judge.due.shift();
      if (next === undefined) break;
      clock.now = next.at;
      next.deliver();
      await flush();
    }
    clock.now = at;
    const samples = stream.slice(index, index + VAD_FRAME_SAMPLES);
    const started = performance.now();
    const probability = await vad.probability(samples);
    sileroMs.push(performance.now() - started);
    frameProbabilities.push(probability);
    detector.push({ samples, probability, at });
    await flush();
  }
  return {
    events,
    probabilities: judge.probabilities,
    measuredMs: judge.measuredMs,
    sileroMs,
    frameProbabilities,
    cancelled,
  };
}

const toMs = (samples: number): number => (samples / TURN_MODEL_SAMPLE_RATE) * 1000;
const peak = (values: readonly number[]): number => Math.max(...values);

function streamFor(line: Spoken, condition: Condition, seed: number): { stream: Float32Array; startMs: number; endMs: number } {
  const lead = Math.round((LEAD_MS / 1000) * TURN_MODEL_SAMPLE_RATE);
  const tail = Math.round((TAIL_MS / 1000) * TURN_MODEL_SAMPLE_RATE);
  const stream = new Float32Array(lead + line.speech.length + tail);
  stream.set(line.speech, lead);
  if (condition === 'noise') {
    const floor = noise(stream.length, NOISE_RMS, seed);
    for (let i = 0; i < stream.length; i += 1) stream[i] = (stream[i] ?? 0) + (floor[i] ?? 0);
  }
  return { stream, startMs: toMs(lead), endMs: toMs(lead + line.speech.length) };
}

const report: string[] = [];
const say = (line = ''): void => {
  console.log(line);
  report.push(line);
};

say(`## live:turn — ${new Date().toISOString().slice(0, 10)}`);
say('');
say(`Kokoro af_heart → 16 kHz, lead ${LEAD_MS} ms, tail ${TAIL_MS} ms. Silero with context unless noted; Smart Turn fp32 on wasm; detector defaults (100 ms candidate, 0.7, 500 ms hangover).`);
say('Offsets are from the labelled end of speech (where synthesis ended), on the audio clock.');

type End = Extract<TurnEvent<null>, { type: 'turn-end' }>;
const isEnd = (event: TurnEvent<null>): event is End => event.type === 'turn-end';

/** Speech ending this far before the label means words followed: the person was cut off. */
const INTERRUPTED_MS = 150;

/**
 * How a run actually ended, after retraction (ADR-25). An end followed by `turn-resumed`
 * is not an end; the first one that stood is. If it stood well before the label, the rest
 * of the sentence became another turn — an interruption, whatever `reason` says.
 */
function outcome(run: Run, labelledEndMs: number) {
  const retracted = new Set(run.events.flatMap((event) => (event.type === 'turn-resumed' ? [event.candidateId] : [])));
  const final = run.events.filter(isEnd).find((event) => !retracted.has(event.candidateId));
  return {
    final,
    retracted: retracted.size,
    interrupted: final !== undefined && final.speechEndAt < labelledEndMs - INTERRUPTED_MS,
  };
}

interface Tally {
  complete: number;
  fired: number;
  interrupted: number;
  incomplete: number;
  falseFires: number;
  retracted: number;
  webgpu: number[];
  measured: number[];
  interruptedMeasured: number;
  late: number;
  wer: number[];
  vadMissed: number;
}
const tally = (): Tally => ({
  complete: 0,
  fired: 0,
  interrupted: 0,
  incomplete: 0,
  falseFires: 0,
  retracted: 0,
  webgpu: [],
  measured: [],
  interruptedMeasured: 0,
  late: 0,
  wer: [],
  vadMissed: 0,
});
const summary: Record<Condition, Tally> = { silence: tally(), noise: tally() };
const allSileroMs: number[] = [];
const allTurnMs: number[] = [];
const int8Pairs: string[] = [];
const contextDiffs: string[] = [];
const fmt = (value: number): string => `${value >= 0 ? '+' : ''}${Math.round(value)}`;
const pList = (values: readonly number[]): string => values.map((value) => value.toFixed(3)).join(', ') || '—';

for (const condition of ['silence', 'noise'] as const) {
  say('');
  say(`### over ${condition === 'silence' ? 'digital silence' : `a noise floor (rms ${NOISE_RMS})`}`);
  say('');
  say('| utterance | label | VAD start | VAD end | p per candidate (fp32) | p (int8) | retracted | ended by | offset, WebGPU latency | offset, measured latency | transcript of the kept audio |');
  say('|---|---|---|---|---|---|---|---|---|---|---|');

  for (const [index, line] of spoken.entries()) {
    const { stream, startMs, endMs } = streamFor(line, condition, index + 1);
    const webgpu = await endpoint(stream, { latency: WEBGPU_ANSWER_MS, context: true, build: 'gpu' });
    const measured = await endpoint(stream, { latency: 'measured', context: true, build: 'gpu' });
    const int8 = await endpoint(stream, { latency: WEBGPU_ANSWER_MS, context: true, build: 'cpu' });
    const bare = await endpoint(stream, { latency: WEBGPU_ANSWER_MS, context: false, build: 'gpu' });
    allSileroMs.push(...webgpu.sileroMs);
    allTurnMs.push(...measured.measuredMs);

    const start = webgpu.events.find((event) => event.type === 'speech-start');
    const fast = outcome(webgpu, endMs);
    const slow = outcome(measured, endMs);
    const t = summary[condition];
    const label = line.complete ? 'complete' : 'incomplete';

    if (start === undefined || fast.final === undefined) {
      t.vadMissed += 1;
      say(`| ${line.text} | ${label} | **not detected** | | | | | | | | |`);
      continue;
    }
    const final = fast.final;
    t.retracted += fast.retracted;
    t.late += measured.events.filter((event) => event.type === 'late').length;

    let verdict: string = final.reason;
    if (line.complete) {
      t.complete += 1;
      if (fast.interrupted) {
        t.interrupted += 1;
        verdict = `**interrupted** (${final.reason})`;
      } else if (final.reason === 'model') {
        t.fired += 1;
        t.webgpu.push(final.at - endMs);
      }
      if (slow.interrupted) t.interruptedMeasured += 1;
      else if (slow.final?.reason === 'model') t.measured.push(slow.final.at - endMs);
    } else {
      t.incomplete += 1;
      if (final.reason === 'model') {
        t.falseFires += 1;
        verdict = '**false fire**';
      }
    }

    // What the worker would hear: the final end's audio, at the worker's token budget.
    const budget = moonshineTokenBudget(final.audio.length, TURN_MODEL_SAMPLE_RATE);
    const heard = (await moonshine(final.audio, { max_new_tokens: budget })).text?.trim() ?? '';
    const wer = wordErrorRate(line.text, heard);
    t.wer.push(wer);

    const slowCell =
      slow.final === undefined
        ? '—'
        : `${fmt(slow.final.at - endMs)} ms (${slow.interrupted ? 'interrupted' : slow.final.reason}${slow.retracted > 0 ? `, ${slow.retracted} retracted` : ''})`;
    say(
      `| ${line.text} | ${label} | ${fmt(start.at - startMs)} | ${fmt(final.speechEndAt - endMs)} ` +
        `| ${pList(webgpu.probabilities)} | ${pList(int8.probabilities)} | ${fast.retracted} | ${verdict} ` +
        `| ${fmt(final.at - endMs)} ms | ${slowCell} ` +
        `| ${wer === 0 ? 'exact' : `wer ${(wer * 100).toFixed(0)}%`}: ${heard} |`,
    );

    int8Pairs.push(`${condition} ${line.complete ? 'C' : 'I'} "${line.text}" fp32 ${pList(webgpu.probabilities)} / int8 ${pList(int8.probabilities)}`);
    const bareStart = bare.events.find((event) => event.type === 'speech-start');
    const bareFinal = outcome(bare, endMs).final;
    const diff =
      webgpu.frameProbabilities.reduce((sum, value, i) => sum + Math.abs(value - (bare.frameProbabilities[i] ?? 0)), 0) /
      webgpu.frameProbabilities.length;
    contextDiffs.push(
      `| ${condition} | ${line.text.slice(0, 32)} | ${diff.toFixed(4)} | ${peak(webgpu.frameProbabilities).toFixed(3)} / ${peak(bare.frameProbabilities).toFixed(3)} ` +
        `| ${fmt(start.at - startMs)} / ${bareStart === undefined ? 'none' : fmt(bareStart.at - startMs)} ` +
        `| ${fmt(final.speechEndAt - endMs)} / ${bareFinal === undefined ? 'none' : fmt(bareFinal.speechEndAt - endMs)} |`,
    );
  }
}

say('');
say('### Summary');
say('');
say('| | complete, ended at its end by the model | complete, interrupted | incomplete, false fire | retractions | model-ended offset at WebGPU latency (median / worst) | same at measured latency (interrupted) | late at measured latency | WER of kept audio (mean) | not detected |');
say('|---|---|---|---|---|---|---|---|---|---|');
for (const condition of ['silence', 'noise'] as const) {
  const t = summary[condition];
  const spread = (values: readonly number[]): string =>
    values.length === 0 ? '—' : `${Math.round(median(values))} / ${Math.round(Math.max(...values))} ms`;
  const meanWer = t.wer.length === 0 ? Number.NaN : t.wer.reduce((a, b) => a + b, 0) / t.wer.length;
  say(
    `| ${condition} | ${t.fired} of ${t.complete} | ${t.interrupted} | ${t.falseFires} of ${t.incomplete} | ${t.retracted} | ${spread(t.webgpu)} | ${spread(t.measured)} (${t.interruptedMeasured}) | ${t.late} | ${(meanWer * 100).toFixed(1)}% | ${t.vadMissed} |`,
  );
}
const everyWebgpu = [...summary.silence.webgpu, ...summary.noise.webgpu];
const interruptions = summary.silence.interrupted + summary.noise.interrupted;
const pass = everyWebgpu.length > 0 && everyWebgpu.every((value) => value <= 300) && interruptions === 0;
say('');
say(
  `**Done-when (complete utterances end within 300 ms of the label at WebGPU latency, none cut off): ${pass ? 'PASS' : 'FAIL'}** — ` +
    `worst ${everyWebgpu.length === 0 ? '—' : Math.round(Math.max(...everyWebgpu))} ms over ${everyWebgpu.length} model-ended turns, ${interruptions} interrupted.`,
);
say('');
say(`Costs on this machine (node, wasm, one thread): Silero median ${median(allSileroMs).toFixed(2)} ms/frame; Smart Turn fp32 log-mel + graph median ${Math.round(median(allTurnMs))} ms, worst ${Math.round(Math.max(...allTurnMs))} ms.`);
say('');
say('### Silero: reference 64-sample context against the bare frame Spikes A and D fed');
say('');
say('| condition | utterance | mean abs p difference per frame | peak p (context / bare) | VAD start offset (context / bare) | final VAD end offset (context / bare) |');
say('|---|---|---|---|---|---|');
for (const row of contextDiffs) say(row);
say('');
say('### fp32 against int8 probabilities, same audio');
say('');
for (const row of int8Pairs) say(`- ${row}`);

writeFileSync(join(out, 'turn.md'), `${report.join('\n')}\n`);
console.log(`\nwritten to ${join(out, 'turn.md')}`);
