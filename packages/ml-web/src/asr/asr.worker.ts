/// <reference lib="webworker" />
import { InterruptableStoppingCriteria, env, pipeline } from '@huggingface/transformers';
import {
  ASR_MODELS,
  ASR_SAMPLE_RATE,
  type AsrDevice,
  type AsrDtype,
  type AsrModelKey,
  type AsrRequest,
  type AsrResponse,
  combinationBlocker,
} from './messages';
import { resample } from './resample';

/**
 * Speech recognition in a worker (P1-T06), built on Spike A's `tts.worker.ts` sibling.
 *
 * **The pipeline does not resample, and that is the whole reason `resample()` is called
 * here.** `prepareAudios` in `src/pipelines.js` hands a `Float32Array` straight to the
 * feature extractor and uses its `sampling_rate` argument only for audio it has to decode
 * itself. Measured on 2026-09-12 (`live/stt.ts`), against the same sentence:
 *
 * | source rate read as 16 kHz | Moonshine | Whisper |
 * |---|---|---|
 * | 24 kHz (1.5x) | perfect | perfect |
 * | 48 kHz (3.0x) | **empty** | **"I'll spawn on your top of your ears for cash."** |
 *
 * No error either time. 48 kHz is what a browser microphone gives you by default, and
 * that Whisper line is what a user would have seen in the transcript.
 *
 * **What is deliberately *not* here: a `max_new_tokens` override.** An earlier version of
 * this worker floored it at 24, reasoning that `_call_moonshine`'s
 * `Math.floor(seconds) * 6` is 0 for anything under a second and would return nothing.
 * Running it showed both halves of that were wrong: a 0.48 s "Yes." transcribes correctly
 * under the model's own budget, and **the floor made it worse** — "Yes, yes, yes.",
 * which is precisely the repetition the Moonshine paper's heuristic exists to prevent.
 * Each pipeline's own budget is left alone.
 */

/** What `pipeline()` returns for this task, narrowed to what this worker uses. */
interface Recogniser {
  (
    audio: Float32Array,
    options: Record<string, unknown>,
  ): Promise<{
    text?: string;
    chunks?: { text?: string; timestamp?: readonly (number | null)[] }[];
  }>;
  dispose?: () => Promise<void>;
}

/**
 * ONNX Runtime throws raw wasm exception pointers, which stringify to a bare number like
 * "321827440" and say nothing. Spike A's lesson, kept: name it rather than printing the
 * pointer and leaving the reader to wonder.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'number') {
    return `ONNX Runtime wasm exception (pointer ${error}) — usually an unsupported op or dtype for this backend`;
  }
  return String(error);
}

function post(message: AsrResponse, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
}

let recogniser: Recogniser | null = null;
let loaded: { model: AsrModelKey; device: AsrDevice; dtype: AsrDtype } | null = null;

/** Requests cancelled before or during generation. An id lands here at most once. */
const cancelled = new Set<number>();
/** The stopping criterion for the request currently generating, so cancel can interrupt it. */
let inFlight: { requestId: number; stop: InterruptableStoppingCriteria } | null = null;

async function load(model: AsrModelKey, device: AsrDevice, dtype: AsrDtype): Promise<void> {
  const blocker = combinationBlocker(device, dtype);
  // Refused here as well as in the provider: this is the boundary that actually touches
  // the runtime, and a combination ADR-20 calls silently wrong must not be reachable by
  // any caller, including a future one that forgets to ask.
  if (blocker !== null) throw new Error(blocker);

  // Weights come from the Hub, never from a local path: there are no models in this repo
  // and there never will be (ADR-09).
  env.allowLocalModels = false;

  // `pipeline` is overloaded across every task transformers supports, and resolving those
  // overloads with an options object produces a union TypeScript refuses to represent
  // (TS2590). Narrowing to the one task this worker uses costs a cast and keeps the rest
  // of the file honestly typed. Spike A hit the same wall.
  const build = pipeline as unknown as (
    task: 'automatic-speech-recognition',
    model: string,
    options: Record<string, unknown>,
  ) => Promise<Recogniser>;

  const started = performance.now();
  recogniser = await build('automatic-speech-recognition', ASR_MODELS[model].modelId, {
    device,
    dtype,
    progress_callback: (progress: unknown) => {
      const update = progress as { status?: string; file?: string; progress?: number };
      if (update.status === 'progress' && typeof update.file === 'string') {
        post({ type: 'progress', file: update.file, percent: Math.round(update.progress ?? 0) });
      }
    },
  });
  loaded = { model, device, dtype };
  post({ type: 'ready', loadMs: performance.now() - started });
}

/** Seconds from the pipeline's chunk timestamps into the protocol's milliseconds. */
function toWords(
  chunks: { text?: string; timestamp?: readonly (number | null)[] }[] | undefined,
  totalMs: number,
): { text: string; startMs: number; endMs: number }[] {
  if (chunks === undefined) return [];
  const words: { text: string; startMs: number; endMs: number }[] = [];
  for (const chunk of chunks) {
    const text = chunk.text?.trim();
    if (text === undefined || text === '') continue;
    const start = chunk.timestamp?.[0];
    // Whisper leaves the final chunk's end null when generation stopped at the budget
    // rather than at a predicted boundary. The clip's own length is the honest fallback.
    const end = chunk.timestamp?.[1];
    if (typeof start !== 'number') continue;
    words.push({
      text,
      startMs: Math.round(start * 1000),
      endMs: typeof end === 'number' ? Math.round(end * 1000) : totalMs,
    });
  }
  return words;
}

async function transcribe(request: Extract<AsrRequest, { type: 'transcribe' }>): Promise<void> {
  if (recogniser === null || loaded === null) throw new Error('transcribe before load');

  // Cancelled while the message was in the queue. Answer the cancel and do no work at all:
  // ADR-21 starts recognition on a candidate window that often turns out not to be a turn.
  if (cancelled.has(request.requestId)) {
    cancelled.delete(request.requestId);
    post({ type: 'cancelled', requestId: request.requestId });
    return;
  }

  const samples = resample(request.samples, request.sampleRate, ASR_SAMPLE_RATE);
  const totalMs = Math.round((samples.length / ASR_SAMPLE_RATE) * 1000);
  const spec = ASR_MODELS[loaded.model];

  const stop = new InterruptableStoppingCriteria();
  inFlight = { requestId: request.requestId, stop };
  try {
    const options: Record<string, unknown> = { stopping_criteria: [stop] };
    if (spec.wordTimestamps) options['return_timestamps'] = 'word';
    if (request.language !== null && spec.languages.length !== 1) {
      options['language'] = request.language;
    }

    const output = await recogniser(samples, options);

    // Interruption is not an error in transformers.js: generation simply returns what it
    // had. Without this check a cancelled turn would deliver a truncated transcript, which
    // is exactly the "no partial text left behind" the done-when asks for.
    if (cancelled.has(request.requestId) || stop.interrupted) {
      cancelled.delete(request.requestId);
      post({ type: 'cancelled', requestId: request.requestId });
      return;
    }

    post({
      type: 'result',
      requestId: request.requestId,
      text: (output.text ?? '').trim(),
      words: toWords(output.chunks, totalMs),
      // No path in transformers.js 3.8.1 surfaces Whisper's detected language — the
      // pipeline consumes it internally and `detect_language` is not exported. Reporting
      // the configured hint here would be inventing a detection that never happened.
      language: spec.languages.length === 1 ? (spec.languages[0] ?? null) : null,
    });
  } finally {
    inFlight = null;
  }
}

self.addEventListener('message', (event: MessageEvent<AsrRequest>) => {
  const message = event.data;

  // Cancel is handled synchronously so it cannot queue behind the generation it is meant
  // to stop — the whole point is to interrupt work already running.
  if (message.type === 'cancel') {
    cancelled.add(message.requestId);
    if (inFlight?.requestId === message.requestId) inFlight.stop.interrupt();
    return;
  }

  void (async () => {
    try {
      if (message.type === 'load') {
        await load(message.model, message.device, message.dtype);
        return;
      }
      await transcribe(message);
    } catch (error) {
      post({
        type: 'error',
        message: describe(error),
        requestId: message.type === 'transcribe' ? message.requestId : null,
      });
    }
  })();
});
