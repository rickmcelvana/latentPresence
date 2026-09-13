import type { AsrModelKey } from '@latentpresence/ml-web';
import { BrowserSTTProvider, type BrowserSttConfig } from './browser-stt';

/**
 * Whisper in the browser (P1-T06).
 *
 * The alternative to Moonshine, and it buys two things Moonshine cannot do: **word
 * timings**, via the pipeline's `return_timestamps: 'word'`, and **languages other than
 * English**. It costs size — `whisper-base` is 294 MB at fp32 against Moonshine tiny's
 * 113 MB — and Spike A never measured its latency, so nothing here should be assumed to
 * fit ADR-20's budget until it is.
 *
 * **It does not detect a language for us**, despite being able to.
 * `WhisperForConditionalGeneration` consumes the detection internally and transformers.js
 * 3.8.1 exports no way to read it back, so `capabilities().languageDetection` is false and
 * `language` on a result is null. Passing `language` tells it which to expect; leaving it
 * null lets it decide and keep the answer to itself.
 */
export type WhisperModel = Extract<AsrModelKey, 'whisper-base' | 'whisper-tiny-en'>;

export interface WhisperBrowserConfig extends Omit<BrowserSttConfig, 'model'> {
  /** Defaults to `whisper-base`, the multilingual one. */
  readonly model?: WhisperModel;
}

export class WhisperBrowserSTTProvider extends BrowserSTTProvider {
  constructor(config: WhisperBrowserConfig) {
    super({ ...config, model: config.model ?? 'whisper-base' });
  }
}
