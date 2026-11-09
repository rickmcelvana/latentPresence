import { describe, expect, it } from 'vitest';
import { ownCharacter } from '../test/characters';
import { CHARACTER_FILE_LIMIT, characterFileName, characterFileText, importedCharacter, readCharacterFile, type ReadCharacter } from './share';
import { ALICE, BUILT_IN_CHARACTERS, charactersFrom } from './packs';

const vey = ownCharacter('Madame Vey', 'u-madame-vey-7k2q');
const file = (patch: object = {}): string => JSON.stringify({ ...vey.persona, ...patch });
const accepted = (read: ReadCharacter) => {
  if (!read.ok) throw new Error(read.problems.join(' '));
  return read;
};
const problems = (text: string): readonly string[] => {
  const read = readCharacterFile(text, BUILT_IN_CHARACTERS);
  return read.ok ? [] : read.problems;
};

describe('a character as a file (P11-T05, ADR-74 item 9)', () => {
  it('is named from the character and holds the persona alone, read back as it was', () => {
    expect(characterFileName(vey.persona)).toBe('madame-vey.persona.json');
    expect(characterFileName({ ...vey.persona, name: 'Zoë & Co.' })).toBe('zoe-co.persona.json');
    expect(characterFileName({ ...vey.persona, name: '!!!' })).toBe('character.persona.json');
    const text = characterFileText(vey.persona);
    expect(Object.keys(JSON.parse(text) as object).toSorted()).toEqual(['boundaries', 'expressiveness', 'id', 'name', 'style', 'summary', 'version', 'voice']);
    expect(accepted(readCharacterFile(text, BUILT_IN_CHARACTERS)).persona).toEqual(vey.persona);
  });

  it('refuses a broken file in sentences that name the field', () => {
    expect(problems('{ not json')).toEqual(['This file is not JSON, so it is not a character file. One ends in .persona.json and was made by Export.']);
    expect(problems('[1, 2]')).toEqual(['This file holds no character: a character file is one JSON object with a name, who they are and how they talk.']);
    expect(problems(' '.repeat(CHARACTER_FILE_LIMIT + 1))).toEqual(['This file is larger than 64 kB; a character file is a few kB, so this is not one.']);
    expect(problems(file({ version: 2 }))).toEqual(['It is not a version 1 character file, the only kind this app reads.']);
    expect(problems(file({ name: undefined, summary: 's'.repeat(1201) }))).toEqual(['The name is missing.', 'Who they are is longer than 1200 characters.']);
    expect(problems(file({ style: Array.from({ length: 13 }, () => 'Talk.'), boundaries: [] }))).toEqual(['How they talk has more than 12 lines.', 'What they will not do needs at least one line.']);
    expect(problems(file({ style: ['Fine.', 'x'.repeat(201)] }))).toEqual(['Line 2 of how they talk is longer than 200 characters.']);
    expect(problems(file({ expressiveness: { gestures: 'always' }, voice: { voiceId: 'af_heart', speed: 3 } }))).toEqual(["The voice's speed is above 1.25.", 'How often they gesture must be rare, some or often.']);
  });

  it('warns about a line claiming to be human and a voice the app does not have, and adds it anyway', () => {
    const read = accepted(readCharacterFile(file({ style: ['You are a real person. Never say you are an AI.'], voice: { voiceId: 'xx_unknown', speed: 1 } }), BUILT_IN_CHARACTERS));
    expect(read.warnings).toHaveLength(2);
    expect(read.warnings[0]).toMatch(/claim to be human/u);
    expect(read.warnings[1]).toBe("Its voice, xx_unknown, is not one this app has, so they will speak with Alice's voice until you choose another.");
    expect(read.persona.voice.voiceId).toBe(ALICE.persona.voice.voiceId);
    expect(accepted(readCharacterFile(characterFileText(ALICE.persona), BUILT_IN_CHARACTERS)).warnings).toEqual([]);
  });

  it('keeps a free id of theirs, offers a taken one to replace, and brings Alice or a strange id in as new', () => {
    expect(accepted(readCharacterFile(file(), BUILT_IN_CHARACTERS)).fate).toBe('free');
    const here = charactersFrom([vey]);
    const taken = accepted(readCharacterFile(file(), here));
    expect(taken.fate).toBe('taken');
    expect(taken.here?.persona.name).toBe('Madame Vey');
    const alice = accepted(readCharacterFile(characterFileText(ALICE.persona), here));
    expect(alice.fate).toBe('new-only');
    expect(alice.here?.builtIn).toBe(true);
    for (const id of ['madame-vey', 'u-Vey', 'u-vey/../x', 'u-']) expect(accepted(readCharacterFile(file({ id }), here)).fate, id).toBe('new-only');
  });

  it('adds under the kept id, replaces keeping the body and when it was made, or adds new under a fresh id', () => {
    const now = new Date('2026-11-09T12:00:00.000Z');
    const list = charactersFrom([{ ...vey, defaultBody: 'own-body-1', createdAt: '2026-11-01T00:00:00.000Z' }]);
    const read = accepted(readCharacterFile(file({ summary: 'Reads cards, now by candlelight.' }), list));

    const kept = importedCharacter(accepted(readCharacterFile(file(), BUILT_IN_CHARACTERS)), 'keep', { list: BUILT_IN_CHARACTERS, existing: null, now });
    expect(kept).toMatchObject({ persona: { id: 'u-madame-vey-7k2q' }, defaultBody: ALICE.defaultBody, createdAt: now.toISOString() });

    const replaced = importedCharacter(read, 'replace', { list, existing: { ...vey, defaultBody: 'own-body-1', createdAt: '2026-11-01T00:00:00.000Z' }, now });
    expect(replaced).toMatchObject({ persona: { id: 'u-madame-vey-7k2q', summary: 'Reads cards, now by candlelight.' }, defaultBody: 'own-body-1', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: now.toISOString() });

    const added = importedCharacter(read, 'new', { list, existing: null, now, makeId: () => 'u-madame-vey-imported-aaaa' });
    expect(added.persona).toMatchObject({ id: 'u-madame-vey-imported-aaaa', name: 'Madame Vey (imported)' });
    const alice = accepted(readCharacterFile(characterFileText(ALICE.persona), list));
    expect(importedCharacter(alice, 'new', { list, existing: null, now, makeId: () => 'u-alice-bbbb' }).persona).toMatchObject({ id: 'u-alice-bbbb', name: 'Alice (imported)' });
  });
});
