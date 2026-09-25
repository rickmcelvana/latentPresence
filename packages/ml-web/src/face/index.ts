// `face.worker.ts` and `create-worker.ts` are deliberately not re-exported: one imports
// MediaPipe, the other makes a worker that can fetch weights. The gated factory in
// `consent/gated-workers.ts` is the way in (P1-T13).
export * from './messages';
