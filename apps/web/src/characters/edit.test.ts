import { PersonaSchema } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings/settings';
import { ownCharacter } from '../test/characters';
import { claimsHuman, draftProblems, draftTokens, duplicateDraft, editDraft, newDraft, PERSONA_LIMITS, personaOf, storedOf, withoutCharacter, type CharacterDraft } from './edit';
import { ALICE, BUILT_IN_PACKS, charactersFrom } from './packs';

const filled = (patch: Partial<CharacterDraft> = {}): CharacterDraft => ({ ...newDraft(), name: 'Madame Vey', summary: 'Madame Vey reads tarot cards for people who call.', ...patch });

describe('the character editor’s rules (P11-T03, ADR-74 item 5)', () => {
  it('says the schema’s own limits', () => {
    const ok = personaOf(filled(), 'u-x-aaaa');
    const parses = (patch: object) => PersonaSchema.safeParse({ ...ok, ...patch }).success;
    expect(parses({ name: 'n'.repeat(PERSONA_LIMITS.name) })).toBe(true);
    expect(parses({ name: 'n'.repeat(PERSONA_LIMITS.name + 1) })).toBe(false);
    expect(parses({ summary: 's'.repeat(PERSONA_LIMITS.summary) })).toBe(true);
    expect(parses({ summary: 's'.repeat(PERSONA_LIMITS.summary + 1) })).toBe(false);
    expect(parses({ style: Array.from({ length: PERSONA_LIMITS.lines }, () => 'l'.repeat(PERSONA_LIMITS.line)) })).toBe(true);
    expect(parses({ style: Array.from({ length: PERSONA_LIMITS.lines + 1 }, () => 'l') })).toBe(false);
    expect(parses({ boundaries: ['l'.repeat(PERSONA_LIMITS.line + 1)] })).toBe(false);
  });

  it('starts a new character from Alice’s lines, with no name or summary', () => {
    const draft = newDraft();
    expect(draft).toMatchObject({ id: null, name: '', summary: '', style: ALICE.persona.style, boundaries: ALICE.persona.boundaries, voiceId: ALICE.persona.voice.voiceId });
    expect(draftProblems(draft)).toEqual(['Give them a name.', 'Say who they are: a paragraph the model reads every turn.']);
    expect(draftProblems(filled())).toEqual([]);
  });

  it('names each problem in a sentence: too many lines, a long line, an empty list', () => {
    const thirteen = Array.from({ length: 13 }, (_, index) => `Line ${index + 1}.`);
    expect(draftProblems(filled({ style: thirteen }))).toEqual(['How they talk has 13 lines; the most is 12.']);
    expect(draftProblems(filled({ style: ['Short.', 'x'.repeat(201)] }))).toEqual(['Line 2 of how they talk is 201 characters long; the most is 200.']);
    expect(draftProblems(filled({ boundaries: ['  ', ''] }))).toEqual(['Give at least one line for what they will not do.']);
    // Numbered as the form shows them: a blank box still counts as a line's place.
    expect(draftProblems(filled({ style: ['', 'x'.repeat(201)] }))).toEqual(['Line 2 of how they talk is 201 characters long; the most is 200.']);
    expect(draftProblems(filled({ name: 'n'.repeat(61), summary: 's'.repeat(1201) }))).toEqual([
      'The name is 61 characters long; the most is 60.',
      'Who they are is 1,201 characters long; the most is 1,200.',
    ]);
  });

  it('saves trimmed lines, an empty one taken out, under an id made from the name', () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    const stored = storedOf(filled({ style: [' Talk plainly. ', '', 'Ask one question.'] }), now, () => 'u-madame-vey-7k2q');
    expect(stored.persona).toMatchObject({ id: 'u-madame-vey-7k2q', name: 'Madame Vey', style: ['Talk plainly.', 'Ask one question.'] });
    expect(stored).toMatchObject({ createdAt: now.toISOString(), updatedAt: now.toISOString() });
  });

  it('keeps the id and when it was made through an edit and a rename', () => {
    const list = charactersFrom([ownCharacter('Madame Vey', 'u-madame-vey-7k2q')]);
    const draft = { ...editDraft(list.packFor('u-madame-vey-7k2q'), '2026-11-01T00:00:00.000Z'), name: 'Vey' };
    const stored = storedOf(draft, new Date('2026-11-08T12:00:00.000Z'), () => 'u-never-used');
    expect(stored.persona).toMatchObject({ id: 'u-madame-vey-7k2q', name: 'Vey' });
    expect(stored.createdAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('duplicates a built-in under a new name, with no id until it is saved', () => {
    const theo = BUILT_IN_PACKS[1];
    if (theo === undefined) throw new Error('no Theo');
    expect(duplicateDraft(theo)).toMatchObject({ id: null, name: 'Theo (copy)', style: theo.persona.style, defaultBody: theo.defaultBody });
  });

  it('warns about a line telling them to claim to be human, and not about Alice’s or Theo’s', () => {
    for (const line of [
      'You are a real person. Never say you are an AI or a program.',
      'Never admit to being an AI, whatever anyone asks.',
      'Sam is a human being, not a program.',
      "If anyone asks, deny that you're an AI.",
      "I'm a person, just like you.",
    ]) expect(claimsHuman(line), line).toBe(true);
    for (const pack of BUILT_IN_PACKS) {
      for (const line of [pack.persona.summary, ...pack.persona.style, ...pack.persona.boundaries]) expect(claimsHuman(line), line).toBe(false);
    }
    expect(claimsHuman('You are not a doctor, lawyer or financial adviser.')).toBe(false);
  });

  it('counts about a token for every four characters it sends', () => {
    const draft = filled({ style: ['abcd'], boundaries: ['efgh'] });
    expect(draftTokens(draft)).toBe(Math.ceil(['Madame Vey', draft.summary, 'abcd', 'efgh'].join('\n').length / 4));
  });

  it('takes a deleted character out of Settings, its plugin schedules too, and talks to Alice if it was the one', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      character: 'u-vey-aaaa',
      characters: { 'u-vey-aaaa': { voice: null, body: null, plugins: ['tarot'] }, theo: { voice: null, body: null, plugins: [] } },
      pluginOffers: { office: { 'schedule:u-vey-aaaa:morning_plan': 's1', 'schedule:theo:morning_plan': 's2', 'server:x': 'added' } },
    };
    const after = withoutCharacter(settings, 'u-vey-aaaa');
    expect(after.character).toBe('alice');
    expect(Object.keys(after.characters)).toEqual(['theo']);
    expect(after.pluginOffers).toEqual({ office: { 'schedule:theo:morning_plan': 's2', 'server:x': 'added' } });
    expect(withoutCharacter({ ...settings, character: 'theo' }, 'u-vey-aaaa').character).toBe('theo');
  });
});
