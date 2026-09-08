/**
 * What Spike A would download, and what the user is shown before it does.
 *
 * ADR-09 is a hard rule: nothing downloads without a consent screen showing size,
 * licence and source. The spike is the first thing in this repo to fetch a weight, so
 * this is where the pattern is set for P1-T13.
 *
 * Sizes and licences are from the Hugging Face API on 2026-09-08 and are recorded in
 * `docs/SURFACE.md`. They are written down rather than fetched so the screen can be
 * shown before any network call — asking the network how big a download is, in order
 * to decide whether to make it, gives the game away.
 */

export interface ModelDownload {
  /** What to call it on screen. */
  readonly label: string;
  /** The Hugging Face repository. */
  readonly repo: string;
  /** SPDX identifier as the repository states it. */
  readonly licence: string;
  /** Bytes fetched on first use, at the quantisation the spike asks for. */
  readonly bytes: number;
  /** Where the user can go and look before agreeing. */
  readonly sourceUrl: string;
  /** Which stage of the pipeline needs it. */
  readonly stage: 'vad' | 'stt' | 'tts';
}

export const SPIKE_MODELS: readonly ModelDownload[] = [
  {
    label: 'Silero VAD',
    repo: 'onnx-community/silero-vad',
    licence: 'MIT',
    bytes: 2_240_000,
    sourceUrl: 'https://huggingface.co/onnx-community/silero-vad',
    stage: 'vad',
  },
  {
    label: 'Moonshine tiny (speech to text)',
    repo: 'onnx-community/moonshine-tiny-ONNX',
    licence: 'MIT',
    // Encoder 7.94 MB + merged decoder 20.24 MB, both quantised.
    bytes: 28_180_000,
    sourceUrl: 'https://huggingface.co/onnx-community/moonshine-tiny-ONNX',
    stage: 'stt',
  },
  {
    label: 'Kokoro 82M (text to speech)',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    licence: 'Apache-2.0',
    bytes: 86_030_000,
    sourceUrl: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
    stage: 'tts',
  },
];

export function totalBytes(models: readonly ModelDownload[] = SPIKE_MODELS): number {
  return models.reduce((sum, model) => sum + model.bytes, 0);
}

/** Megabytes to one decimal, which is the honest precision for a download estimate. */
export function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
