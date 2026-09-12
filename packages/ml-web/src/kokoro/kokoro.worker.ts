/// <reference lib="webworker" />
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import type { KokoroDevice, KokoroDtype, KokoroRequest, KokoroResponse } from './messages';

/**
 * Kokoro in a worker (P1-T05).
 *
 * Synthesis on WebGPU holds the main thread long enough to drop avatar frames, and the
 * avatar is the product; so it runs here and the samples cross by transfer. This file is
 * the shipping version of `apps/web/src/spikes/tts.worker.ts`, which Spike A proved out
 * and which stays where it is as the reference measurement.
 *
 * Two things in it are not obvious and both are recorded surface, not preference:
 *
 * 1. **The splitter is built here.** `stream()` given a plain string hangs in kokoro-js
 *    1.2.1: it creates a `TextSplitterStream`, pushes, and never calls `close()`, while a
 *    sentence whose terminator is the last character is only flushed by `close()`. The
 *    generator then waits forever — no audio, no completion, no error. Observed live on
 *    2026-09-08 (`docs/SURFACE.md`).
 * 2. **Cancellation is checked between chunks.** kokoro-js exposes no abort, so a
 *    cancelled request stops at the next sentence boundary. Since the caller sends one
 *    sentence at a time (P1-T04 already split the stream), that is usually immediate.
 *
 * There is no test for this file. It needs a browser, a GPU and 325 MB of weights; what
 * can be tested without those is the port contract, and `KokoroBrowserTTSProvider` is
 * where that lives.
 */

/** Loaded model, or null before the first `load`. */
let tts: KokoroTTS | null = null;

/** Requests cancelled since they were accepted. Small and short-lived: an id is added by
 * `cancel` and removed when the request it names stops. */
const cancelled = new Set<number>();

function post(message: KokoroResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

/**
 * ONNX Runtime throws raw wasm exception pointers, which stringify to a bare number and
 * say nothing at all. Name that for what it is rather than printing the pointer.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'number') {
    return `ONNX Runtime wasm exception (pointer ${error}) — usually an unsupported op or dtype for this backend`;
  }
  return String(error);
}

async function load(device: KokoroDevice, dtype: KokoroDtype): Promise<void> {
  const started = performance.now();
  tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype,
    device,
    progress_callback: (progress: unknown) => {
      const update = progress as { status?: string; file?: string; progress?: number };
      if (update.status === 'progress' && typeof update.file === 'string') {
        post({ type: 'progress', file: update.file, percent: Math.round(update.progress ?? 0) });
      }
    },
  });
  post({ type: 'ready', loadMs: performance.now() - started });
}

async function speak(request: Extract<KokoroRequest, { type: 'speak' }>): Promise<void> {
  if (tts === null) throw new Error('speak before load');

  const sentences = new TextSplitterStream();
  sentences.push(request.text);
  sentences.close();

  // `voice` is typed as a union of the 28 built-in ids. The id reaching this worker came
  // out of `listVoices()`, which reads that same table, so the cast narrows rather than
  // widens — and a wrong id still throws from kokoro-js's own `_validate_voice`.
  const options = { voice: request.voice, speed: request.speed } as Parameters<
    KokoroTTS['stream']
  >[1];

  let index = 0;
  for await (const chunk of tts.stream(sentences, options)) {
    if (cancelled.has(request.requestId)) break;
    // `chunk.audio.audio` is the Float32Array. Copy it so the buffer can be transferred
    // without the library's own reference going with it.
    const samples = Float32Array.from(chunk.audio.audio);
    post(
      {
        type: 'audio',
        requestId: request.requestId,
        index,
        samples,
        sampleRate: chunk.audio.sampling_rate,
        text: chunk.text,
      },
      [samples.buffer],
    );
    index += 1;
  }

  cancelled.delete(request.requestId);
  post({ type: 'done', requestId: request.requestId });
}

self.addEventListener('message', (event: MessageEvent<KokoroRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelled.add(message.requestId);
    return;
  }
  void (async () => {
    try {
      if (message.type === 'load') await load(message.device, message.dtype);
      else await speak(message);
    } catch (error) {
      post({
        type: 'error',
        requestId: message.type === 'speak' ? message.requestId : null,
        message: describe(error),
      });
    }
  })();
});
