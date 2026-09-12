import type { TtsVoice } from '@latentpresence/protocol';

/**
 * Kokoro's 28 built-in voices (P1-T05).
 *
 * This table is a copy, and the copy is deliberate: kokoro-js 1.2.1 exports only
 * `KokoroTTS`, `TextSplitterStream` and `env` from its package root, so `VOICES` is
 * reachable only through a *loaded* model — and the settings UI must list voices before
 * the user has consented to downloading 325 MB of weights (ADR-09). Reading the table
 * from an instance would mean the consent screen comes after the choice it exists to
 * inform.
 *
 * A copy that nothing checks is how a provider goes quietly wrong, so `voices.test.ts`
 * parses the installed `kokoro-js` bundle and fails if these ids drift from it. That is
 * the P1-T04 lesson applied: verifying code proves it self-consistent, never that it
 * agrees with a value it copied.
 *
 * Fields are exactly as kokoro-js states them, including `language: 'en-us'` in lower
 * case and the letter grades from the upstream model card. Nothing is inferred: the
 * gender of a voice is what the table says, never what the name suggests.
 */
export interface KokoroVoice {
  readonly id: string;
  readonly name: string;
  /** BCP-47 as kokoro-js writes it — `en-us` / `en-gb`, not re-cased. */
  readonly language: string;
  readonly gender: 'Female' | 'Male';
  /** The model card's grade for this voice. `af_heart` is the only A. */
  readonly overallGrade: string;
}

export const kokoroVoices: readonly KokoroVoice[] = [
  { id: 'af_heart', name: 'Heart', language: 'en-us', gender: 'Female', overallGrade: 'A' },
  { id: 'af_alloy', name: 'Alloy', language: 'en-us', gender: 'Female', overallGrade: 'C' },
  { id: 'af_aoede', name: 'Aoede', language: 'en-us', gender: 'Female', overallGrade: 'C+' },
  { id: 'af_bella', name: 'Bella', language: 'en-us', gender: 'Female', overallGrade: 'A-' },
  { id: 'af_jessica', name: 'Jessica', language: 'en-us', gender: 'Female', overallGrade: 'D' },
  { id: 'af_kore', name: 'Kore', language: 'en-us', gender: 'Female', overallGrade: 'C+' },
  { id: 'af_nicole', name: 'Nicole', language: 'en-us', gender: 'Female', overallGrade: 'B-' },
  { id: 'af_nova', name: 'Nova', language: 'en-us', gender: 'Female', overallGrade: 'C' },
  { id: 'af_river', name: 'River', language: 'en-us', gender: 'Female', overallGrade: 'D' },
  { id: 'af_sarah', name: 'Sarah', language: 'en-us', gender: 'Female', overallGrade: 'C+' },
  { id: 'af_sky', name: 'Sky', language: 'en-us', gender: 'Female', overallGrade: 'C-' },
  { id: 'am_adam', name: 'Adam', language: 'en-us', gender: 'Male', overallGrade: 'F+' },
  { id: 'am_echo', name: 'Echo', language: 'en-us', gender: 'Male', overallGrade: 'D' },
  { id: 'am_eric', name: 'Eric', language: 'en-us', gender: 'Male', overallGrade: 'D' },
  { id: 'am_fenrir', name: 'Fenrir', language: 'en-us', gender: 'Male', overallGrade: 'C+' },
  { id: 'am_liam', name: 'Liam', language: 'en-us', gender: 'Male', overallGrade: 'D' },
  { id: 'am_michael', name: 'Michael', language: 'en-us', gender: 'Male', overallGrade: 'C+' },
  { id: 'am_onyx', name: 'Onyx', language: 'en-us', gender: 'Male', overallGrade: 'D' },
  { id: 'am_puck', name: 'Puck', language: 'en-us', gender: 'Male', overallGrade: 'C+' },
  { id: 'am_santa', name: 'Santa', language: 'en-us', gender: 'Male', overallGrade: 'D-' },
  { id: 'bf_emma', name: 'Emma', language: 'en-gb', gender: 'Female', overallGrade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', language: 'en-gb', gender: 'Female', overallGrade: 'C' },
  { id: 'bm_george', name: 'George', language: 'en-gb', gender: 'Male', overallGrade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', language: 'en-gb', gender: 'Male', overallGrade: 'D+' },
  { id: 'bf_alice', name: 'Alice', language: 'en-gb', gender: 'Female', overallGrade: 'D' },
  { id: 'bf_lily', name: 'Lily', language: 'en-gb', gender: 'Female', overallGrade: 'D' },
  { id: 'bm_daniel', name: 'Daniel', language: 'en-gb', gender: 'Male', overallGrade: 'D' },
  { id: 'bm_fable', name: 'Fable', language: 'en-gb', gender: 'Male', overallGrade: 'C' },
];

/** The voice the character speaks with unless the user picks another. `af_heart` is the
 * only A-graded voice in the table, and kokoro-js's own default. */
export const KOKORO_DEFAULT_VOICE = 'af_heart';

/** Kokoro's table in the protocol's shape. `gender` maps by value, never by name: a
 * label the table does not state becomes `unknown` rather than a guess. */
export function toTtsVoices(voices: readonly KokoroVoice[] = kokoroVoices): TtsVoice[] {
  return voices.map((voice) => ({
    id: voice.id,
    label: `${voice.name} (${voice.language}, ${voice.overallGrade})`,
    language: voice.language,
    gender: voice.gender === 'Female' ? 'female' : voice.gender === 'Male' ? 'male' : 'unknown',
  }));
}
