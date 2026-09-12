import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { KOKORO_DEFAULT_VOICE, kokoroVoices, toTtsVoices } from './voices';

/**
 * The drift guard for the copied voice table.
 *
 * `kokoroVoices` is a copy of a table that kokoro-js does not export, so nothing but
 * this test ties the two together. It reads the installed bundle and compares — no
 * network, no model download, and it fails the moment a `pnpm update` changes the voice
 * list underneath us.
 *
 * This is the P1-T04 lesson made routine: a value duplicated from somewhere else needs a
 * test against that somewhere, because compiling proves only self-consistency.
 */

/** Voice ids as the installed kokoro-js bundle lists them. */
function voiceIdsFromBundle(): string[] {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('kokoro-js'), 'utf8');
  const table = /(af_heart:\{.*?bm_fable:\{[^}]*\})/s.exec(source);
  const block = table?.[1];
  if (block === undefined) {
    throw new Error('voice table not found in the installed kokoro-js bundle');
  }
  return [...block.matchAll(/([a-z]{2}_[a-z]+):\{/g)].map((match) => match[1] ?? '');
}

describe('kokoroVoices', () => {
  it('lists exactly the voices the installed kokoro-js has', () => {
    expect(kokoroVoices.map((voice) => voice.id)).toEqual(voiceIdsFromBundle());
  });

  it('names a default that is in the table', () => {
    expect(kokoroVoices.some((voice) => voice.id === KOKORO_DEFAULT_VOICE)).toBe(true);
  });

  it('states a language and a gender for every voice', () => {
    for (const voice of kokoroVoices) {
      expect(voice.language).toMatch(/^en-(us|gb)$/);
      expect(['Female', 'Male']).toContain(voice.gender);
    }
  });
});

describe('toTtsVoices', () => {
  it('maps gender by what the table says', () => {
    const mapped = toTtsVoices([
      { id: 'x_f', name: 'F', language: 'en-us', gender: 'Female', overallGrade: 'A' },
      { id: 'x_m', name: 'M', language: 'en-gb', gender: 'Male', overallGrade: 'C' },
    ]);
    expect(mapped.map((voice) => voice.gender)).toEqual(['female', 'male']);
  });

  it('carries the language through unchanged, lower case and all', () => {
    expect(toTtsVoices().every((voice) => voice.language === voice.language?.toLowerCase())).toBe(
      true,
    );
  });

  it('produces one protocol voice per table entry', () => {
    expect(toTtsVoices()).toHaveLength(kokoroVoices.length);
  });
});
