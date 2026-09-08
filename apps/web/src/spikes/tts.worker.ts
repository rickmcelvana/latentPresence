/// <reference lib="webworker" />
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import type { SpikeDtype } from './consent';

/**
 * Kokoro through kokoro-js.
 *
 * `stream()` yields per sentence, which is what makes "first audio" a real measurement
 * rather than "the whole utterance finished". The 800 ms budget in RESEARCH §3.3 assumes
 * streaming synthesis; if this ever stops streaming, the budget stops being reachable.
 *
 * The splitter is built here rather than letting `stream()` take a plain string, because
 * that path in kokoro-js 1.2.1 never terminates: it creates a TextSplitterStream, pushes
 * the text, and never closes it, while a sentence whose terminator sits at the end of the
 * buffer is only emitted by the flush that `close()` performs. The generator then waits
 * forever for input that cannot arrive — no audio, no completion, no error
 * (docs/SURFACE.md, 2026-09-08).
 */

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';

type InboundMessage =
  | { readonly type: 'load'; readonly device: 'webgpu' | 'wasm'; readonly dtype: SpikeDtype }
  | { readonly type: 'speak'; readonly text: string };

type OutboundMessage =
  | { readonly type: 'ready'; readonly loadMs: number }
  | { readonly type: 'progress'; readonly file: string; readonly percent: number }
  | {
      readonly type: 'audio';
      readonly samples: Float32Array;
      readonly sampleRate: number;
      readonly index: number;
    }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string };

/**
 * ONNX Runtime throws raw wasm exception pointers, which stringify to a bare number like
 * "321827440" and say nothing. Name that for what it is rather than printing the pointer
 * and leaving the reader to wonder.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'number') {
    return `ONNX Runtime wasm exception (pointer ${error}) — usually an unsupported op or dtype for this backend`;
  }
  return String(error);
}

function post(message: OutboundMessage, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

let tts: KokoroTTS | null = null;

async function load(device: 'webgpu' | 'wasm', dtype: SpikeDtype): Promise<void> {
  const started = performance.now();
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
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

async function speak(text: string): Promise<void> {
  if (tts === null) throw new Error('speak before load');

  const sentences = new TextSplitterStream();
  sentences.push(text);
  sentences.close();

  let index = 0;
  for await (const chunk of tts.stream(sentences, { voice: VOICE })) {
    // `chunk.audio.audio` is the Float32Array; copy it so the buffer can be transferred
    // without the library's own reference going with it.
    const samples = Float32Array.from(chunk.audio.audio);
    post(
      { type: 'audio', samples, sampleRate: chunk.audio.sampling_rate, index },
      [samples.buffer],
    );
    index += 1;
  }
  post({ type: 'done' });
}

self.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === 'load') await load(message.device, message.dtype);
      else await speak(message.text);
    } catch (error) {
      post({ type: 'error', message: describe(error) });
    }
  })();
});
