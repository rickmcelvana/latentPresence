import type { CancellationSignal, TTSProvider } from '@latentpresence/protocol';
import { DEFAULT_VOICED_THRESHOLD, trimToVoice, type EdgePadding } from '../playback/prefix';

/**
 * The backchannels a character can say, synthesised once in its own voice (P1-T09).
 *
 * **Words, not "mm-hm".** Kokoro's phonemizer reads nonverbal spellings as letters: "Mm-hmm."
 * becomes /ˌɛmˈɛmhəm/ and "Mhm." /ˌɛmˌeɪtʃˈɛm/ — "em-aitch-em" — and every other spelling
 * tried did the same or became a different word (`pnpm live:backchannel`, `docs/SURFACE.md`).
 * Short words phonemize as themselves on every voice tried, and they reach a TTS server as
 * plain text too, so the default set is words. A nonverbal set needs phoneme input, which
 * `TTSProvider` does not have, and an ear to judge it.
 */

/**
 * Phonemized as themselves by Kokoro on `af_heart` and `am_michael`, and the shortest words
 * that still read as listening: 351–503 ms of voice. Length matters because a clip starts
 * ~160 ms into a pause and is faded the moment the user speaks again (ADR-28), so a word
 * that runs 600 ms ("I see.", "Okay.") is cut in more of the pauses a speaker takes.
 */
export const DEFAULT_BACKCHANNEL_PHRASES: readonly string[] = ['Yeah.', 'Right.', 'Yes.', 'Oh.'];

/**
 * A backchannel is one word on its own, with no sentence after it to leave a gap for, so
 * the tail is as short as the lead. The lead keeps ADR-27's 50 ms for soft onsets ("y", "s").
 */
export const BACKCHANNEL_PADDING: EdgePadding = { leadMs: 50, tailMs: 50 };

export interface BackchannelClip {
  readonly text: string;
  /** Mono PCM, trimmed. Never handed to a sink directly: the sink may transfer it. */
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

export interface PrepareBackchannelsOptions {
  readonly voiceId: string;
  readonly speed?: number;
  readonly phrases?: readonly string[];
  readonly padding?: EdgePadding;
  readonly signal?: CancellationSignal;
}

/**
 * Synthesise every phrase, one after another, and trim each to its voice. A phrase that
 * comes back empty or silent is left out rather than failing the set; a provider that
 * throws fails it, because the next phrase would fail the same way.
 */
export async function prepareBackchannels(
  tts: TTSProvider,
  options: PrepareBackchannelsOptions,
): Promise<BackchannelClip[]> {
  const clips: BackchannelClip[] = [];
  for (const text of options.phrases ?? DEFAULT_BACKCHANNEL_PHRASES) {
    if (options.signal?.aborted === true) break;
    const parts: Float32Array[] = [];
    let sampleRate = 0;
    const request = { text, voiceId: options.voiceId, speed: options.speed ?? 1, hint: null };
    for await (const audio of tts.synthesize(request, options.signal === undefined ? {} : { signal: options.signal })) {
      if (audio.samples.length === 0) continue;
      parts.push(audio.samples);
      sampleRate = audio.sampleRate;
    }
    const whole = join(parts);
    if (!whole.some((sample) => Math.abs(sample) >= DEFAULT_VOICED_THRESHOLD)) continue;
    const { samples } = trimToVoice(whole, sampleRate, options.padding ?? BACKCHANNEL_PADDING);
    clips.push({ text, samples, sampleRate });
  }
  return clips;
}

function join(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
