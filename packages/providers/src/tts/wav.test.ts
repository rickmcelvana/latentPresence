import { describe, expect, it } from 'vitest';
import { decodePcm16, decodeWav, encodeWav, WavParseError } from './wav';

/**
 * The fixtures are built here byte by byte rather than read from a file, because the
 * interesting cases are the malformed-but-real ones — a placeholder length from a
 * streaming writer, an odd-sized `LIST` before `data` — and those are easier to state in
 * code than to find a sample of. A real response from a real server is the manual verify
 * in `docs/briefs/P1-T05.md`; this is the shape coverage.
 */

interface Chunk {
  readonly id: string;
  readonly body: Uint8Array;
  /** What the header claims, when that should differ from `body.length`. */
  readonly declaredSize?: number;
}

function riff(chunks: readonly Chunk[], form = 'WAVE'): Uint8Array {
  const bodies = chunks.map((chunk) => {
    const padded = chunk.body.length % 2 === 1 ? chunk.body.length + 1 : chunk.body.length;
    const out = new Uint8Array(8 + padded);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i += 1) view.setUint8(i, chunk.id.charCodeAt(i));
    view.setUint32(4, chunk.declaredSize ?? chunk.body.length, true);
    out.set(chunk.body, 8);
    return out;
  });

  const size = bodies.reduce((total, body) => total + body.length, 0);
  const out = new Uint8Array(12 + size);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, 'RIFF'.charCodeAt(i));
  view.setUint32(4, 4 + size, true);
  for (let i = 0; i < 4; i += 1) view.setUint8(8 + i, form.charCodeAt(i));
  let offset = 12;
  for (const body of bodies) {
    out.set(body, offset);
    offset += body.length;
  }
  return out;
}

function fmtChunk(options: {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}): Chunk {
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  view.setUint16(0, options.formatTag, true);
  view.setUint16(2, options.channels, true);
  view.setUint32(4, options.sampleRate, true);
  view.setUint32(8, (options.sampleRate * options.channels * options.bitsPerSample) / 8, true);
  view.setUint16(12, (options.channels * options.bitsPerSample) / 8, true);
  view.setUint16(14, options.bitsPerSample, true);
  return { id: 'fmt ', body };
}

/** `fmt ` as WAVE_FORMAT_EXTENSIBLE, with the real tag in the first two bytes of the GUID. */
function extensibleFmtChunk(realTag: number, bitsPerSample: number): Chunk {
  const body = new Uint8Array(40);
  const view = new DataView(body.buffer);
  view.setUint16(0, 0xfffe, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, 24_000, true);
  view.setUint16(14, bitsPerSample, true);
  view.setUint16(16, 22, true);
  view.setUint16(24, realTag, true);
  return { id: 'fmt ', body };
}

function pcm16(values: readonly number[]): Uint8Array {
  const body = new Uint8Array(values.length * 2);
  const view = new DataView(body.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return body;
}

function float32(values: readonly number[]): Uint8Array {
  const body = new Uint8Array(values.length * 4);
  const view = new DataView(body.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return body;
}

const MONO_16 = { formatTag: 1, channels: 1, sampleRate: 24_000, bitsPerSample: 16 };

describe('decodeWav', () => {
  it('reads 16-bit mono PCM at the rate the header states', () => {
    const wav = riff([fmtChunk(MONO_16), { id: 'data', body: pcm16([0, 16_384, -16_384]) }]);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.channels).toBe(1);
    expect([...decoded.samples]).toEqual([0, 0.5, -0.5]);
  });

  it('maps the extremes without clipping', () => {
    const wav = riff([fmtChunk(MONO_16), { id: 'data', body: pcm16([32_767, -32_768]) }]);
    const [high, low] = decodeWav(wav).samples;
    expect(high).toBeCloseTo(1, 4);
    expect(low).toBe(-1);
  });

  it('reads 32-bit float PCM', () => {
    const wav = riff([
      fmtChunk({ ...MONO_16, formatTag: 3, bitsPerSample: 32 }),
      { id: 'data', body: float32([0.25, -0.75]) },
    ]);
    expect([...decodeWav(wav).samples]).toEqual([0.25, -0.75]);
  });

  it('follows WAVE_FORMAT_EXTENSIBLE to the real format tag', () => {
    const wav = riff([extensibleFmtChunk(1, 16), { id: 'data', body: pcm16([16_384]) }]);
    expect([...decodeWav(wav).samples]).toEqual([0.5]);
  });

  it('averages a stereo file down to mono', () => {
    const wav = riff([
      fmtChunk({ ...MONO_16, channels: 2 }),
      { id: 'data', body: pcm16([16_384, -16_384, 32_766, 0]) },
    ]);
    const decoded = decodeWav(wav);
    expect(decoded.channels).toBe(2);
    expect([...decoded.samples]).toEqual([0, 0.499969482421875]);
  });

  it('drops a trailing partial frame rather than reading past the end', () => {
    const wav = riff([
      fmtChunk({ ...MONO_16, channels: 2 }),
      { id: 'data', body: pcm16([16_384, 16_384, 16_384]) },
    ]);
    expect([...decodeWav(wav).samples]).toEqual([0.5]);
  });

  it('walks past a LIST chunk to find the data — and past its pad byte', () => {
    const wav = riff([
      fmtChunk(MONO_16),
      { id: 'LIST', body: new Uint8Array([1, 2, 3]) },
      { id: 'data', body: pcm16([16_384]) },
    ]);
    expect([...decodeWav(wav).samples]).toEqual([0.5]);
  });

  it('accepts fmt after another chunk', () => {
    const wav = riff([
      { id: 'JUNK', body: new Uint8Array(4) },
      fmtChunk(MONO_16),
      { id: 'data', body: pcm16([-16_384]) },
    ]);
    expect([...decodeWav(wav).samples]).toEqual([-0.5]);
  });

  it('reads to the end when the data size is a streaming placeholder of zero', () => {
    const wav = riff([
      fmtChunk(MONO_16),
      { id: 'data', body: pcm16([16_384, -16_384]), declaredSize: 0 },
    ]);
    expect([...decodeWav(wav).samples]).toEqual([0.5, -0.5]);
  });

  it('reads to the end when the data size is 0xffffffff', () => {
    const wav = riff([
      fmtChunk(MONO_16),
      { id: 'data', body: pcm16([16_384]), declaredSize: 0xffff_ffff },
    ]);
    expect([...decodeWav(wav).samples]).toEqual([0.5]);
  });

  it('never reads past the buffer when the declared size overshoots it', () => {
    const wav = riff([fmtChunk(MONO_16), { id: 'data', body: pcm16([16_384]), declaredSize: 4096 }]);
    expect([...decodeWav(wav).samples]).toEqual([0.5]);
  });

  it('honours a declared size smaller than what follows it', () => {
    const wav = riff([
      fmtChunk(MONO_16),
      { id: 'data', body: pcm16([16_384, -16_384]), declaredSize: 2 },
    ]);
    expect([...decodeWav(wav).samples]).toEqual([0.5]);
  });

  it('decodes a buffer that is a view into a larger one', () => {
    const wav = riff([fmtChunk(MONO_16), { id: 'data', body: pcm16([16_384]) }]);
    const backing = new Uint8Array(wav.length + 16);
    backing.set(wav, 8);
    expect([...decodeWav(backing.subarray(8, 8 + wav.length)).samples]).toEqual([0.5]);
  });

  it('refuses a buffer that is not RIFF', () => {
    const bytes = new TextEncoder().encode('this is an mp3, honestly');
    expect(() => decodeWav(bytes)).toThrow(WavParseError);
  });

  it('refuses a RIFF that is not WAVE', () => {
    expect(() => decodeWav(riff([fmtChunk(MONO_16)], 'AVI '))).toThrow(/not WAVE/);
  });

  it('refuses a file with no data chunk', () => {
    expect(() => decodeWav(riff([fmtChunk(MONO_16)]))).toThrow(/no data chunk/);
  });

  it('refuses data before fmt, rather than guessing the rate', () => {
    expect(() => decodeWav(riff([{ id: 'data', body: pcm16([0]) }, fmtChunk(MONO_16)]))).toThrow(
      /before fmt/,
    );
  });

  it('names the encoding it will not decode — mp3 in a RIFF container, say', () => {
    const wav = riff([
      fmtChunk({ ...MONO_16, formatTag: 0x0055, bitsPerSample: 0 }),
      { id: 'data', body: new Uint8Array(8) },
    ]);
    expect(() => decodeWav(wav)).toThrow(/unsupported WAV encoding: format 85/);
  });

  it('refuses 24-bit PCM by name instead of returning noise', () => {
    const wav = riff([
      fmtChunk({ ...MONO_16, bitsPerSample: 24 }),
      { id: 'data', body: new Uint8Array(9) },
    ]);
    expect(() => decodeWav(wav)).toThrow(/24 bits per sample/);
  });

  it('refuses something far too short to be a header', () => {
    expect(() => decodeWav(new Uint8Array(4))).toThrow(/too short/);
  });
});

describe('decodePcm16', () => {
  it('decodes headerless samples at the rate it is told', () => {
    const decoded = decodePcm16(pcm16([0, 16_384]), 24_000);
    expect(decoded.sampleRate).toBe(24_000);
    expect([...decoded.samples]).toEqual([0, 0.5]);
  });

  it('drops a trailing odd byte rather than reading past the end', () => {
    expect(decodePcm16(new Uint8Array([0, 0, 0]), 24_000).samples).toHaveLength(1);
  });
});

describe('encodeWav', () => {
  it('round-trips through the decoder at the same rate and length', () => {
    const samples = new Float32Array(256);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 6) * 0.8;
    const decoded = decodeWav(encodeWav(samples, 16_000));
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.samples).toHaveLength(256);
    for (let i = 0; i < samples.length; i += 1) {
      // 16-bit quantisation, so within one step of full scale rather than exact.
      expect(decoded.samples[i]).toBeCloseTo(samples[i] ?? 0, 3);
    }
  });

  it('clamps rather than wrapping a sample above full scale', () => {
    // Kokoro's own output peaks at 1.043 (measured 2026-09-12). Wrapping that into an
    // Int16 flips the polarity and becomes a loud click.
    const decoded = decodeWav(encodeWav(new Float32Array([1.043, -1.2, 0]), 24_000));
    expect(decoded.samples[0]).toBeCloseTo(1, 3);
    expect(decoded.samples[1]).toBeCloseTo(-1, 3);
    expect(decoded.samples[2]).toBe(0);
  });

  it('writes a header a parser can find the rate in', () => {
    const bytes = encodeWav(new Float32Array(8), 48_000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
    expect(bytes).toHaveLength(44 + 16);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(16);
  });

  it('encodes an empty clip as a valid header with no data', () => {
    expect(decodeWav(encodeWav(new Float32Array(0), 16_000)).samples).toHaveLength(0);
  });

  it('rejects a rate that is not a rate', () => {
    expect(() => encodeWav(new Float32Array(4), 0)).toThrow(RangeError);
    expect(() => encodeWav(new Float32Array(4), Number.NaN)).toThrow(RangeError);
  });
});
