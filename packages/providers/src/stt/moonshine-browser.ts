import type { AsrModelKey } from '@latentpresence/ml-web';
import { BrowserSTTProvider, type BrowserSttConfig } from './browser-stt';

/**
 * Moonshine in the browser (P1-T06).
 *
 * The default recognition path, because it is the one Spike A measured: 180 ms on
 * WebGPU/fp32 inside ADR-20's 500 ms pipeline budget. It is English-only and reports no
 * word timings — `_call_moonshine` in transformers.js returns `{ text }` and nothing else
 * — so anything wanting timestamps or another language wants `WhisperBrowserSTTProvider`
 * and should expect to pay for it.
 *
 * `tiny` is 113 MB at fp32 against `base`'s 251 MB. Spike A measured tiny; base is offered
 * because a slower machine may prefer accuracy over the latency it has already lost.
 */
export type MoonshineModel = Extract<AsrModelKey, 'moonshine-tiny' | 'moonshine-base'>;

export interface MoonshineBrowserConfig extends Omit<BrowserSttConfig, 'model' | 'language'> {
  /** Defaults to `moonshine-tiny`, the configuration Spike A measured. */
  readonly model?: MoonshineModel;
}

export class MoonshineBrowserSTTProvider extends BrowserSTTProvider {
  constructor(config: MoonshineBrowserConfig) {
    super({
      ...config,
      model: config.model ?? 'moonshine-tiny',
      // Moonshine is English-only, and `_call_moonshine` warns and ignores a `language`
      // rather than failing. Pinning it null here means the setting never looks honoured.
      language: null,
    });
  }
}
