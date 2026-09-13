// `silero.ts` and `smart-turn.ts` are deliberately not re-exported: they import ONNX
// Runtime and transformers.js, and anything on the main thread importing this barrel
// would pull both into the page bundle before the consent screen had been answered.
// Workers and live checks import them by path.
export * from './messages';
export * from './turn-audio';
export { createSmartTurnWorker, createVadWorker } from './create-worker';
