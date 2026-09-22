/// <reference lib="webworker" />
import { cachedModelFetch } from '../consent/model-cache';
import { SILERO_VAD, modelUrl, sileroVadModel, type VadRequest, type VadResponse } from './messages';
import { SileroVad, createSileroSession } from './silero';

/**
 * Silero VAD in a worker (P1-T07), promoted from Spike A's `vad.worker.ts`.
 *
 * Everything that decided *when* a turn was over has left this file: hysteresis,
 * pre-roll, candidates and the hangover are `TurnDetector` in `packages/core`, where a
 * scripted stream of numbers tests them. What is left is a model: a frame in, the frame
 * and its probability out, in order.
 *
 * **The weights are fetched here, not handed to ort as a URL (P1-T13).** `createSileroSession`
 * used to be given `modelUrl(SILERO_VAD)` directly and ort fetched it internally, a request
 * nothing of ours ever saw — it could not be shown on a consent screen first and never
 * landed in transformers.js's cache (`docs/SURFACE.md`). `cachedModelFetch` is the seam
 * that replaces it: gating already happened one layer up, in whichever
 * `createGatedVadWorker` caller posted `load` at all, so this file's job is only to fetch
 * the bytes it was already allowed to want, check their size, and hand ort a buffer.
 */

function post(message: VadResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'number') {
    return `ONNX Runtime wasm exception (pointer ${error}) — usually an unsupported op or dtype for this backend`;
  }
  return String(error);
}

let vad: SileroVad | null = null;

async function load(): Promise<void> {
  const started = performance.now();
  const bytes = await cachedModelFetch(modelUrl(SILERO_VAD), sileroVadModel());
  vad = new SileroVad(await createSileroSession(bytes));
  post({ type: 'ready', loadMs: performance.now() - started });
}

self.addEventListener('message', (event: MessageEvent<VadRequest>) => {
  const message = event.data;
  if (message.type === 'load') {
    load().catch((error: unknown) => post({ type: 'error', message: describe(error) }));
    return;
  }
  if (vad === null) {
    post({ type: 'error', message: `${message.type} before load` });
    return;
  }
  if (message.type === 'reset') {
    void vad.reset();
    return;
  }
  const { samples, at } = message;
  // `probability` serialises internally, so answers come back in the order frames came in
  // even though nothing here awaits.
  vad.probability(samples).then(
    (probability) => post({ type: 'probability', samples, probability, at }, [samples.buffer]),
    (error: unknown) => post({ type: 'error', message: describe(error) }),
  );
});
