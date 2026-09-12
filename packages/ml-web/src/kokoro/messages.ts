import type { ModelDescriptor } from '@latentpresence/protocol';

/**
 * The contract between the Kokoro worker and whatever drives it (P1-T05).
 *
 * It lives here rather than in `packages/providers` because both ends need it and only
 * one end is a provider: the worker is a transformers.js wrapper, which ADR-11 puts in
 * `packages/ml-web`. `KokoroBrowserTTSProvider` imports these types and never imports
 * the worker itself, which is what keeps the provider testable in node.
 *
 * Everything crossing the port is structured-cloneable. `Float32Array` is, and its
 * buffer is transferred rather than copied — synthesis produces tens of thousands of
 * samples per sentence and this runs inside a 500 ms budget (ADR-20).
 */

/** What kokoro-js 1.2.1 accepts for `from_pretrained({ dtype })`. Verified against the
 * installed `types/kokoro.d.ts`; `q8f16` is a file in the repo but not a value here. */
export type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

/** The two devices we offer. kokoro-js also accepts `cpu` and `null`; `cpu` is the node
 * backend and is not reachable from a browser worker, so it is not offered. */
export type KokoroDevice = 'webgpu' | 'wasm';

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/**
 * Kokoro's output rate, in Hz. kokoro-js 1.2.1 hard-codes it — `new RawAudio(data, 24e3)`
 * in `dist/kokoro.js` — so it is a constant here rather than a reading from the first
 * chunk. The chunk still carries the rate it was produced at; this is what
 * `capabilities()` can promise before anything has been synthesised.
 */
export const KOKORO_SAMPLE_RATE = 24_000;

/**
 * Bytes on the wire for the Kokoro graph at each precision, from the Hugging Face API on
 * 2026-09-08 (`docs/SURFACE.md`). ADR-09 means the consent screen shows this number
 * before a byte moves, so it is a recorded fact and not an estimate.
 *
 * fp16 and fp32 are the only entries Spike A measured. q4/q4f16 exist in kokoro-js's
 * dtype union and have no recorded size, so they are absent here and
 * `kokoroModel` refuses them rather than inventing one.
 */
const KOKORO_BYTES = {
  q8: 86_030_000,
  fp16: 163_230_000,
  fp32: 325_530_000,
} as const satisfies Partial<Record<KokoroDtype, number>>;

/** The precisions whose download size is a recorded fact. */
export type KokoroSizedDtype = keyof typeof KOKORO_BYTES;

/** True for a dtype we can quote a download size for, and therefore can consent to. */
export function hasRecordedSize(dtype: KokoroDtype): dtype is KokoroSizedDtype {
  return dtype === 'q8' || dtype === 'fp16' || dtype === 'fp32';
}

/**
 * What the consent screen (P1-T13) shows before Kokoro is fetched. A function of the
 * precision because the sizes differ by a factor of four, and showing the wrong one
 * would be exactly the misrepresentation ADR-09 exists to prevent.
 */
export function kokoroModel(dtype: KokoroSizedDtype): ModelDescriptor {
  return {
    id: `${KOKORO_MODEL_ID}:${dtype}`,
    label: `Kokoro 82M (text to speech, ${dtype})`,
    sizeBytes: KOKORO_BYTES[dtype],
    licence: 'Apache-2.0',
    sourceUrl: `https://huggingface.co/${KOKORO_MODEL_ID}`,
  };
}

/** Main thread to worker. */
export type KokoroRequest =
  | { readonly type: 'load'; readonly device: KokoroDevice; readonly dtype: KokoroDtype }
  | {
      readonly type: 'speak';
      readonly requestId: number;
      readonly text: string;
      readonly voice: string;
      readonly speed: number;
    }
  /**
   * Stop producing audio for a request. kokoro-js 1.2.1 has no abort, so this takes
   * effect at the next sentence boundary: the sentence being synthesised finishes
   * inside the worker and is dropped rather than posted. Barge-in's audible half is the
   * output queue's 100 ms fade (P1-T08); this only stops the tap.
   */
  | { readonly type: 'cancel'; readonly requestId: number };

/** Worker to main thread. */
export type KokoroResponse =
  | { readonly type: 'ready'; readonly loadMs: number }
  | { readonly type: 'progress'; readonly file: string; readonly percent: number }
  | {
      readonly type: 'audio';
      readonly requestId: number;
      readonly index: number;
      readonly samples: Float32Array;
      readonly sampleRate: number;
      /** The sentence these samples say, as kokoro-js split it. Useful for the transcript. */
      readonly text: string;
    }
  | { readonly type: 'done'; readonly requestId: number }
  /** `requestId` is null for a failure that belongs to the worker rather than a request. */
  | { readonly type: 'error'; readonly requestId: number | null; readonly message: string };

/**
 * The worker as its driver sees it.
 *
 * Deliberately not `Worker`'s own shape. An `EventTarget` signature drags `MessageEvent`
 * and `EventListenerOrEventListenerObject` into every fake, and under
 * `strictFunctionTypes` a hand-written listener is not assignable to `EventListener`
 * anyway. Two methods and an unsubscribe function fake in four lines and adapt to a real
 * `Worker` in six (`createKokoroWorker`).
 */
export interface KokoroWorkerPort {
  post(message: KokoroRequest, transfer?: readonly Transferable[]): void;
  /** Attach a message sink. The returned function detaches it. */
  onMessage(listener: (message: KokoroResponse) => void): () => void;
  terminate(): void;
}
