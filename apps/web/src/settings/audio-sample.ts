import type { MinimalAudioContext } from './deps';

/** Play once through a fresh `AudioContext` (created by the caller, on the click that
 * asked for it) and release it when playback ends. */
export async function playSamples(context: MinimalAudioContext, samples: Float32Array, sampleRate: number): Promise<void> {
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  // `Float32Array.from` rebuilds onto a plain `ArrayBuffer`: the samples an adapter
  // yields are typed against the DOM-free protocol package, whose `Float32Array` is not
  // guaranteed to share this lib's `ArrayBuffer`-backed generic.
  buffer.copyToChannel(Float32Array.from(samples), 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.addEventListener('ended', () => {
    void context.close();
  });
  source.start();
}
