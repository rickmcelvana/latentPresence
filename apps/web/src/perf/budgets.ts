import type { BundleBudgets } from './bundle-budget.ts';

/**
 * P9-T02 (ADR-68): the performance budgets, in one place, each enforced where it can be
 * measured honestly. PLAN.md's targets are about a person's machine — 60 fps at 1080p on a
 * mid-range GPU, under 400 MB of browser memory without models, the pipeline under 500 ms
 * excluding the model — and a CI runner has no GPU and runs the models as fakes. So CI holds
 * the **inputs** those depend on and that this code controls, at what they measure now plus
 * headroom; the outputs stay with the live checks on real hardware (R-13, R-9).
 *
 * Raising a number is allowed and is a decision: say why in the commit.
 */

/** Gzipped bytes before each page draws (`pnpm build`, both operating systems). */
export const BUNDLE_BUDGETS: BundleBudgets = {
  routes: {
    boot: { chunks: [], maxGzipBytes: 195_000 },
    welcome: { chunks: ['WelcomePage'], maxGzipBytes: 220_000 },
    settings: { chunks: ['SettingsPage'], maxGzipBytes: 230_000 },
    chat: { chunks: ['ChatPage', 'CallStage'], maxGzipBytes: 470_000 },
    privacy: { chunks: ['PrivacyPage'], maxGzipBytes: 220_000 },
  },
  // What loads after a page has drawn, in raw bytes: the AI SDK on the first message, and the
  // voice and the face reading on Start, after their consent. ONNX Runtime's and MediaPipe's
  // wasm are third-party and are here so a dependency bump that doubles one is seen.
  files: [
    { stem: 'llm-provider.js', maxBytes: 600_000 },
    { stem: 'vad.worker.js', maxBytes: 435_000 },
    { stem: 'smart-turn.worker.js', maxBytes: 980_000 },
    { stem: 'asr.worker.js', maxBytes: 980_000 },
    { stem: 'kokoro.worker.js', maxBytes: 2_450_000 },
    { stem: 'ser.worker.js', maxBytes: 440_000 },
    // 150 kB until P9-T05: each worker now carries the table of pinned hashes (16 kB raw, ADR-70).
    { stem: 'face.worker.js', maxBytes: 165_000 },
    { stem: 'vision_wasm_module_internal.js', maxBytes: 355_000 },
    { stem: 'vision_wasm_module_internal.wasm', maxBytes: 12_300_000 },
    { stem: 'ort-wasm-simd-threaded.jsep.wasm', maxBytes: 23_800_000 },
  ],
  unbudgetedFileMaxBytes: 100_000,
};

/**
 * One frame of the call at 1920×1080 with the default body (`e2e/perf.spec.ts`, the e2e
 * job): what 60 fps depends on, in units a software rasteriser measures the same as a GPU.
 */
export const STAGE_BUDGET = {
  // Measured 2026-11-01: 51 calls, 138,904 triangles, 13 programs, 32 textures, 7.46 MB of
  // scene textures, 31.5 MB of heap — the same on two runs but for the heap (±0.1%).
  drawCalls: 60,
  triangles: 160_000,
  programs: 16,
  textures: 40,
  textureBytes: 9_000_000,
  /** The page's JavaScript heap after a collection, with the body loaded and no model. */
  heapBytes: 48_000_000,
} as const;

/**
 * The voice pipeline's own share of ADR-20's 500 ms (`e2e/voice.spec.ts`, the e2e job): from
 * the turn's end to the first audio with the model, recognition and the voice faked as
 * instant, so what is left is this code — the reply, the sentence split, the queue and the
 * playback worklet starting.
 */
export const PIPELINE_BUDGET = {
  // Measured 2026-11-01: 9.3, 9.5 and 9.4 ms. Fifty leaves a slow runner room and still fails
  // a debounce or a timer anyone adds to the path.
  ownShareMs: 50,
} as const;
