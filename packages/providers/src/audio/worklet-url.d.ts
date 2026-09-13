/**
 * Vite's `?worker&url` import: the URL of a module bundled into its own chunk. The audio
 * worklets are loaded this way (`create-audio.ts`). Declared here rather than by pulling in
 * `vite/client`, which would put Vite's whole ambient surface into a provider package.
 */
declare module '*?worker&url' {
  const url: string;
  export default url;
}
