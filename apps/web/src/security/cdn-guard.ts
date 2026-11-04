/**
 * The build fails if a worker would run ONNX Runtime from a CDN (P9-T05, ADR-70).
 *
 * transformers.js points `wasmPaths` at jsDelivr as a side effect of being imported, so **any**
 * worker importing it inherits that, including one that only wanted a feature extractor: Smart
 * Turn did, and was found only by watching the network on a real load. It is not in the page's
 * Content Security Policy's reach either, and no CI job loads a real model. What a build can see
 * is that a chunk holds the CDN's address without the app's own hashed copy of the runtime, which
 * is what setting `ORT_WASM_PATHS` adds.
 */

const CDN = 'cdn.jsdelivr.net';
const OWN_RUNTIME = /ort-wasm-simd-threaded\.jsep-[\w-]{8}\.mjs/u;

export interface BuiltCode {
  readonly fileName: string;
  readonly code: string;
}

/** One sentence per chunk that would fetch its runtime from the CDN. */
export function cdnRuntimeProblems(files: readonly BuiltCode[]): string[] {
  return files
    .filter((file) => file.fileName.endsWith('.js') && file.code.includes(CDN) && !OWN_RUNTIME.test(file.code))
    .map((file) => `${file.fileName} would load ONNX Runtime from ${CDN}: set wasmPaths to ORT_WASM_PATHS in that worker (ADR-70)`);
}
