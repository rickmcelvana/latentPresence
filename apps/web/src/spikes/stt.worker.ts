/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { SpikeDtype } from './consent';

/**
 * Moonshine tiny through transformers.js.
 *
 * The device is explicit on both paths: left alone, transformers defaults to q8 on wasm
 * and fp32 on webgpu, and the spike would then be comparing quantisations rather than
 * backends (docs/SURFACE.md).
 */

const MODEL_ID = 'onnx-community/moonshine-tiny-ONNX';

type InboundMessage =
  | { readonly type: 'load'; readonly device: 'webgpu' | 'wasm'; readonly dtype: SpikeDtype }
  | { readonly type: 'transcribe'; readonly samples: Float32Array };

type OutboundMessage =
  | { readonly type: 'ready'; readonly loadMs: number }
  | { readonly type: 'progress'; readonly file: string; readonly percent: number }
  | { readonly type: 'result'; readonly text: string }
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

function post(message: OutboundMessage): void {
  (self as unknown as Worker).postMessage(message);
}

let recogniser: AutomaticSpeechRecognitionPipeline | null = null;

async function load(device: 'webgpu' | 'wasm', dtype: SpikeDtype): Promise<void> {
  // Weights come from the Hub, never from a local path: there are no models in this
  // repo and there never will be (ADR-09).
  env.allowLocalModels = false;

  // `pipeline` is overloaded across every task transformers supports, and resolving
  // those overloads with an options object produces a union TypeScript refuses to
  // represent (TS2590). Narrowing it to the one task this worker uses costs a cast and
  // keeps the rest of the file honestly typed.
  const buildRecogniser = pipeline as unknown as (
    task: 'automatic-speech-recognition',
    model: string,
    options: Record<string, unknown>,
  ) => Promise<AutomaticSpeechRecognitionPipeline>;

  const started = performance.now();
  recogniser = await buildRecogniser('automatic-speech-recognition', MODEL_ID, {
    device,
    dtype,
    progress_callback: (progress: unknown) => {
      const update = progress as { status?: string; file?: string; progress?: number };
      if (update.status === 'progress' && typeof update.file === 'string') {
        post({ type: 'progress', file: update.file, percent: Math.round(update.progress ?? 0) });
      }
    },
  });
  post({ type: 'ready', loadMs: performance.now() - started });
}

self.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === 'load') {
        await load(message.device, message.dtype);
        return;
      }
      if (recogniser === null) throw new Error('transcribe before load');

      const output = await recogniser(message.samples);
      const text = Array.isArray(output)
        ? output.map((part) => part.text).join(' ')
        : output.text;
      post({ type: 'result', text: text.trim() });
    } catch (error) {
      post({ type: 'error', message: describe(error) });
    }
  })();
});
