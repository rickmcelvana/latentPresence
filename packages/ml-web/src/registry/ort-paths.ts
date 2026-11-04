import mjs from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import wasm from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';

/**
 * ONNX Runtime from the build, not from a CDN (P9-T05, ADR-70).
 *
 * transformers.js sets `wasmPaths` to `cdn.jsdelivr.net/npm/@huggingface/transformers@<version>/dist/`
 * unless it is already set (`src/backends/onnx.js`), and given a path ONNX Runtime imports its
 * `.mjs` from there and fetches its 21.6 MB wasm. That is **code from a third party, run in the
 * voice workers**, on no consent screen, with no hash, and untouched by the page's Content
 * Security Policy, which a worker does not inherit. Both files are in the build already, so the
 * Kokoro, recognition and Smart Turn workers point at those: the three that import transformers.js,
 * and the build fails if a fourth forgets (`apps/web/src/security/cdn-guard.ts`). Imported by those
 * workers only, because of what `?url` emits. The relative path is because the package's `exports` does not list the files.
 */
export const ORT_WASM_PATHS = { mjs, wasm };
