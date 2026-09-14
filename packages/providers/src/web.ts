/**
 * The model-free half of this package, for code that ships in the production app (P1-T10).
 *
 * The root entry re-exports the browser STT/TTS/turn providers, which import
 * `@latentpresence/ml-web`, and that alone puts onnxruntime's wasm into a production bundle
 * — the build guard in `apps/web/vite.config.ts` fails on it (measured 2026-09-14: importing
 * only `llmPresets` from the root was enough). Nothing exported here reaches ml-web,
 * and the production build's guard is what proves it: the settings page imports this entry.
 */
export * from './access';
export * from './llm';
export { OpenAICompatibleTTSProvider, type OpenAICompatibleTtsConfig } from './tts/openai-compatible-tts';
export { OpenAICompatibleSTTProvider, type OpenAICompatibleSttConfig } from './stt/openai-compatible-stt';
