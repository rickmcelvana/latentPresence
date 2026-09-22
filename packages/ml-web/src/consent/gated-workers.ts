import { asrModel, type AsrDtype, type AsrModelKey, type AsrWorkerPort } from '../asr';
import { createAsrWorker } from '../asr/create-worker';
import { kokoroModel, type KokoroSizedDtype, type KokoroWorkerPort } from '../kokoro';
import { createKokoroWorker } from '../kokoro/create-worker';
import {
  sileroVadModel,
  smartTurnModel,
  type SmartTurnBuild,
  type SmartTurnWorkerPort,
  type VadWorkerPort,
} from '../turn';
import { createSmartTurnWorker, createVadWorker } from '../turn/create-worker';
import { requireConsent, type ModelConsent } from './consent';

/**
 * The four worker-creating entry points (P1-T13), one per model this project offers in a
 * browser. Each is `requireConsent` first, `create*Worker` second — the whole structural
 * gate lives in that ordering, not in anything wrapping `fetch`.
 *
 * `requireConsent` throwing here means the real `new Worker(...)` below it never runs, so
 * neither the worker thread nor anything inside it — `InferenceSession.create`,
 * `pipeline()`, `KokoroTTS.from_pretrained` — can possibly have started. A worker that does
 * not exist cannot fetch, which is the point of gating *here* rather than inside the
 * worker: none of those four calls happen on this thread, and a worker has no
 * `localStorage` to ask a second time (`docs/SURFACE.md`).
 *
 * **These are the only exported way to make one of these workers.** The ungated
 * `create*Worker` functions are no longer re-exported from their barrels, so bypassing the
 * gate is a compile error rather than a thing a future caller can do by accident.
 *
 * Kept apart from `../asr`, `../kokoro` and `../turn`'s barrels, and out of
 * `consent/index.ts`'s safe subpath, because importing these pulls in the four
 * `create*Worker` functions and, through the worker chunks Vite builds for them, ONNX
 * Runtime, transformers.js and kokoro-js. Only the dev harness (`apps/web/src/dev`,
 * gated out of production by `apps/web/vite.config.ts`) should import this file.
 */

export function createGatedVadWorker(consent: ModelConsent): VadWorkerPort {
  requireConsent(consent, [sileroVadModel()]);
  return createVadWorker();
}

export function createGatedSmartTurnWorker(consent: ModelConsent, build: SmartTurnBuild): SmartTurnWorkerPort {
  requireConsent(consent, [smartTurnModel(build)]);
  return createSmartTurnWorker();
}

export function createGatedAsrWorker(consent: ModelConsent, model: AsrModelKey, dtype: AsrDtype): AsrWorkerPort {
  requireConsent(consent, [asrModel(model, dtype)]);
  return createAsrWorker();
}

export function createGatedKokoroWorker(consent: ModelConsent, dtype: KokoroSizedDtype): KokoroWorkerPort {
  requireConsent(consent, [kokoroModel(dtype)]);
  return createKokoroWorker();
}
