/**
 * Just enough RIFF to turn a `/audio/speech` response into samples (P1-T05).
 *
 * The pipeline wants `Float32Array` mono PCM: that is what `SpokenAudioChunk` carries and
 * what an AudioWorklet queue plays (P1-T08). Getting there from an HTTP response means
 * either `AudioContext.decodeAudioData` — which needs a DOM, cannot run under vitest, and
 * would make every test of this provider a browser test — or parsing the container here.
 *
 * So the adapter asks for `wav` and this parses it. `wav` rather than `pcm` for one
 * reason: `pcm` is headerless, so its sample rate has to come from somewhere else, and
 * the only available somewhere else is a guess. A WAV header states it (ADR-24).
 *
 * Two rules that come from real servers rather than from the spec:
 *
 * - **The declared `data` size is advisory.** Kokoro-FastAPI streams by default and
 *   writes its WAV header through PyAV before it knows the length, so the size field can
 *   be a placeholder. Everything after the header is audio; the declared size is used
 *   only as an upper bound.
 * - **Chunks are walked, not assumed.** `LIST`/`INFO` before `data` is common, and
 *   `fmt ` is not always chunk one.
 */

/** Mono samples and the rate the file says they were made at. */
export interface DecodedAudio {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** Channels in the source, before the downmix. 1 for everything a TTS returns. */
  readonly channels: number;
}

/** WAVE format tags, as the `fmt ` chunk writes them. */
const FORMAT_PCM = 0x0001;
const FORMAT_FLOAT = 0x0003;
const FORMAT_EXTENSIBLE = 0xfffe;

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export class WavParseError extends Error {}

interface Format {
  readonly formatTag: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
}

/**
 * Decode a RIFF/WAVE buffer to mono `Float32Array`.
 *
 * Multi-channel input is averaged down rather than refused: nothing in the voice
 * pipeline is stereo, but a server that returns it should be played rather than thrown
 * at the user.
 */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) throw new WavParseError('too short to be a WAV file');
  if (ascii(view, 0) !== 'RIFF') throw new WavParseError('not a RIFF file');
  if (ascii(view, 8) !== 'WAVE') throw new WavParseError('RIFF file is not WAVE');

  let format: Format | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(view, offset);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const remaining = bytes.byteLength - body;

    if (id === 'fmt ') {
      if (declared < 16 || remaining < 16) throw new WavParseError('fmt chunk is truncated');
      format = {
        formatTag: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
      // WAVE_FORMAT_EXTENSIBLE hides the real tag in the first two bytes of the GUID.
      if (format.formatTag === FORMAT_EXTENSIBLE && declared >= 40 && remaining >= 26) {
        format = { ...format, formatTag: view.getUint16(body + 24, true) };
      }
    } else if (id === 'data') {
      if (format === null) throw new WavParseError('data chunk arrived before fmt');
      // A streaming writer cannot know the length, so the declared size is a ceiling and
      // never a promise. 0 and 0xffffffff are the two placeholders seen in the wild.
      const usable =
        declared === 0 || declared === 0xffff_ffff ? remaining : Math.min(declared, remaining);
      return decodeSamples(bytes.subarray(body, body + usable), format);
    }

    // RIFF pads odd-sized chunks to an even boundary; the pad byte is not counted in the
    // declared size, so walking without this drifts one byte and finds no `data`.
    offset = body + declared + (declared % 2);
  }

  throw new WavParseError('no data chunk');
}

function decodeSamples(data: Uint8Array, format: Format): DecodedAudio {
  const { channels, sampleRate, formatTag, bitsPerSample } = format;
  if (channels < 1) throw new WavParseError('fmt claims no channels');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const interleaved = readInterleaved(view, formatTag, bitsPerSample);
  const frames = Math.floor(interleaved.length / channels);

  if (channels === 1) {
    return { samples: interleaved.subarray(0, frames), sampleRate, channels };
  }

  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += interleaved[frame * channels + channel] ?? 0;
    }
    mono[frame] = sum / channels;
  }
  return { samples: mono, sampleRate, channels };
}

function readInterleaved(view: DataView, formatTag: number, bitsPerSample: number): Float32Array {
  if (formatTag === FORMAT_FLOAT && bitsPerSample === 32) {
    const count = Math.floor(view.byteLength / 4);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(i * 4, true);
    return out;
  }

  if (formatTag === FORMAT_PCM && bitsPerSample === 16) {
    const count = Math.floor(view.byteLength / 2);
    const out = new Float32Array(count);
    // 32768 rather than 32767: it maps the full negative range without clipping, and the
    // half-LSB of headroom it costs is inaudible.
    for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 32_768;
    return out;
  }

  throw new WavParseError(
    `unsupported WAV encoding: format ${formatTag}, ${bitsPerSample} bits per sample`,
  );
}

/**
 * Headerless 16-bit little-endian PCM, for a server configured to answer
 * `response_format: 'pcm'`. The rate cannot be read from the bytes, so the caller has to
 * state it — which is exactly why `wav` is the default.
 */
export function decodePcm16(bytes: Uint8Array, sampleRate: number): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(i * 2, true) / 32_768;
  return { samples, sampleRate, channels: 1 };
}
