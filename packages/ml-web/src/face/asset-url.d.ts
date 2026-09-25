/**
 * Vite's `?url` import: the URL of a file served as-is. The face worker loads MediaPipe's
 * wasm loader and binary this way (`face.worker.ts`). Declared here rather than by pulling
 * in `vite/client`, the same choice `providers/src/audio/worklet-url.d.ts` made.
 */
declare module '*?url' {
  const url: string;
  export default url;
}
