/// <reference lib="webworker" />
import { SILERO_VAD, modelUrl, type VadRequest, type VadResponse } from './messages';
import { SileroVad, createSileroSession } from './silero';

/**
 * Silero VAD in a worker (P1-T07), promoted from Spike A's `vad.worker.ts`.
 *
 * Everything that decided *when* a turn was over has left this file: hysteresis,
 * pre-roll, candidates and the hangover are `TurnDetector` in `packages/core`, where a
 * scripted stream of numbers tests them. What is left is a model: a frame in, the frame
 * and its probability out, in order.
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
  vad = new SileroVad(await createSileroSession(modelUrl(SILERO_VAD)));
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
