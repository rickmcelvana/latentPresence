/**
 * Sample-rate conversion for speech recognition input.
 *
 * Every ASR model this project ships expects **16 kHz mono**, and a browser microphone
 * delivers whatever the device felt like — 44.1 or 48 kHz normally, 16 kHz on some
 * headsets. transformers.js does not resample a raw `Float32Array`: it takes the samples
 * as already being at the model's rate, so handing it 48 kHz audio does not error, it
 * transcribes a recording of someone talking three times too fast. The failure is silent
 * and produces confident nonsense, which is the expensive kind.
 *
 * Linear interpolation is the obvious cheap answer and the wrong one when *downsampling*:
 * everything above 8 kHz in the source folds back into the speech band as aliasing, and
 * sibilants are exactly where the energy above 8 kHz lives. So this low-passes first, with
 * the filter built into the same kernel that interpolates — a windowed sinc, evaluated per
 * output sample. At 16 kHz out and 32 taps it is well under a millisecond per second of
 * audio, which is nothing next to the recognition it feeds.
 */

/**
 * Half-width of the kernel in source samples. 16 gives a 32-tap filter: enough stopband
 * rejection for speech, cheap enough to ignore.
 */
const HALF_WIDTH = 16;

/** `sin(pi x) / (pi x)`, with the removable singularity at 0 filled in. */
function sinc(x: number): number {
  if (x === 0) return 1;
  const scaled = Math.PI * x;
  return Math.sin(scaled) / scaled;
}

/**
 * Blackman window. Chosen over Hann for its deeper stopband (−58 dB against −31 dB):
 * the point of the filter is to keep high-frequency source content out of the speech
 * band, so leakage is the whole quantity being bought.
 */
function blackman(position: number, width: number): number {
  const phase = (2 * Math.PI * position) / width;
  return 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
}

/**
 * Resample mono `samples` from `from` Hz to `to` Hz.
 *
 * Returns the input untouched when the rates already match — the common case on a device
 * that happens to capture at 16 kHz, and worth not paying for.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (!Number.isFinite(from) || from <= 0) throw new RangeError(`source rate ${from} is not a rate`);
  if (!Number.isFinite(to) || to <= 0) throw new RangeError(`target rate ${to} is not a rate`);
  if (from === to) return samples;
  if (samples.length === 0) return samples;

  const ratio = to / from;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const output = new Float32Array(length);

  // Cutoff sits at the lower Nyquist of the two rates. Upsampling needs no low-pass, so
  // the kernel collapses to plain sinc interpolation and `scale` is 1.
  const scale = Math.min(1, ratio);
  const width = HALF_WIDTH / scale;

  for (let i = 0; i < length; i += 1) {
    // Where this output sample falls in the source, in source samples.
    const centre = i / ratio;
    const first = Math.ceil(centre - width);
    const last = Math.floor(centre + width);

    let total = 0;
    let weightSum = 0;
    for (let j = first; j <= last; j += 1) {
      const offset = centre - j;
      const weight = scale * sinc(scale * offset) * blackman(offset + width, 2 * width);
      // Clamping the index extends the edge sample rather than treating the outside as
      // silence, which would otherwise fade the first and last millisecond.
      const index = j < 0 ? 0 : j >= samples.length ? samples.length - 1 : j;
      total += (samples[index] ?? 0) * weight;
      weightSum += weight;
    }

    // Normalising by the realised weight keeps the gain at exactly 1 despite the window
    // truncating the kernel, so a resampled clip has the same loudness as its source.
    output[i] = weightSum === 0 ? 0 : total / weightSum;
  }

  return output;
}

/**
 * Average interleaved channels down to mono, in place of the caller doing it badly.
 * Recognition models take one channel and summing is how a stereo mic becomes one.
 */
export function toMono(interleaved: Float32Array, channels: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1) {
    throw new RangeError(`channel count ${channels} is not a count`);
  }
  if (channels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const output = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      total += interleaved[frame * channels + channel] ?? 0;
    }
    output[frame] = total / channels;
  }
  return output;
}
