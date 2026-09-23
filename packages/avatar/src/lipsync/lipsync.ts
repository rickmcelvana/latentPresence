import type { WordTiming } from '@latentpresence/protocol';
import { VisemeClassifier } from './classifier';
import { DEFAULT_MOUTH_PARAMS, MouthDriver, type MouthParams, type MouthWeights, visemeAt } from './mouth';

/** One frame of `getByteFrequencyData`, from wherever the voice is. */
export interface SpectrumSource {
  readonly sampleRate: number;
  readonly fftSize: number;
  read(into: Uint8Array<ArrayBuffer>): void;
}

/**
 * **1024 bins with no smoothing** — measured, not chosen (P2-T04, `docs/SURFACE.md`). At
 * our 24 kHz context that is the 23 Hz bin width wawa-lipsync's thresholds were tuned
 * at (2048 bins at 48 kHz), and with the analyser's own smoothing off the mouth is half
 * shut 41 ms after a sound ends instead of wawa's 153. `MouthDriver` does the smoothing,
 * asymmetrically, where it can be tuned.
 */
export const ANALYSER_FFT_SIZE = 1024;

/**
 * Taps a node in the voice's own graph — `AudioOutputHandle.node`, which P1-T08 exposed
 * for exactly this. The analyser is a side branch: the voice's path to the speakers is
 * untouched, and `disconnect` removes only the tap.
 */
export function tapAnalyser(
  context: BaseAudioContext,
  node: AudioNode,
  fftSize = ANALYSER_FFT_SIZE,
): SpectrumSource & { disconnect(): void } {
  const analyser = context.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;
  node.connect(analyser);
  return {
    sampleRate: context.sampleRate,
    fftSize,
    read: (into) => analyser.getByteFrequencyData(into),
    disconnect: () => node.disconnect(analyser),
  };
}

/**
 * Lip sync for one voice: the ported classifier over an analyser, or word timings when a
 * TTS supplies them, into `MouthDriver`. Call `update` once per rendered frame and hand
 * each weight to `AvatarRenderer.setViseme`.
 */
export class LipSync {
  private readonly source: SpectrumSource;
  private readonly classifier = new VisemeClassifier();
  private readonly mouth: MouthDriver;
  private readonly bins: Uint8Array<ArrayBuffer>;
  private timeline: { readonly words: readonly WordTiming[]; readonly startedAt: number } | null = null;

  constructor(source: SpectrumSource, params: MouthParams = DEFAULT_MOUTH_PARAMS) {
    this.source = source;
    this.mouth = new MouthDriver(params);
    this.bins = new Uint8Array(source.fftSize / 2);
  }

  /**
   * Drive from word timings instead of the analyser, from `startedAt` (the same clock as
   * `update`'s `nowMs`) until the last word ends. Null goes back to the analyser.
   */
  useTimings(words: readonly WordTiming[] | null, startedAt = 0): void {
    this.timeline = words === null || words.length === 0 ? null : { words, startedAt };
  }

  update(deltaMs: number, nowMs: number): MouthWeights {
    const timeline = this.timeline;
    if (timeline !== null) {
      const at = nowMs - timeline.startedAt;
      const last = timeline.words[timeline.words.length - 1];
      if (last !== undefined && at < last.endMs) {
        const { viseme, volume } = visemeAt(timeline.words, at);
        return this.mouth.update(viseme, volume, deltaMs);
      }
      this.timeline = null;
    }
    this.source.read(this.bins);
    const { viseme, features } = this.classifier.classify(this.bins, this.source.sampleRate, this.source.fftSize, nowMs);
    return this.mouth.update(viseme, features.volume, deltaMs);
  }

  reset(): void {
    this.classifier.reset();
    this.mouth.reset();
    this.timeline = null;
  }
}
