// The production-safe half of this folder: consent bookkeeping and the cached-fetch
// helper, neither of which imports ONNX Runtime, transformers.js or kokoro-js. Published
// as its own subpath (`@latentpresence/ml-web/consent`) so `/settings`, which ships in
// production, can read and revoke consent without pulling in `gated-workers.ts` — that one
// imports the four `create*Worker` functions, and through them the worker chunks
// `apps/web/vite.config.ts`'s build guard keeps out of every production route but
// `/dev/voice` (P1-T08's guard, extended here rather than worked around).
export * from './consent';
export * from './model-cache';
