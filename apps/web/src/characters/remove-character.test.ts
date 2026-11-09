import { FakeMemoryStore } from '@latentpresence/core';
import { describe, expect, it } from 'vitest';
import { ownCharacter } from '../test/characters';
import { InMemoryCharacterShelf } from './character-shelf';
import { removeCharacter, removedWords } from './remove-character';

describe('deleting a character (P11-T03, P11-T04)', () => {
  it('says what went, in words', () => {
    expect(removedWords('Vey', { schedules: 0, forgotten: null })).toBe('Vey was deleted.');
    expect(removedWords('Vey', { schedules: 2, forgotten: null })).toBe('Vey was deleted, with 2 schedules.');
    expect(removedWords('Vey', { schedules: 1, forgotten: { episodes: 1204, facts: 14, plans: 0, blocks: 1, schedules: 1 } })).toBe(
      'Vey was deleted, and what they remembered is gone: 1,204 turns, 14 facts, one note and one schedule.',
    );
    expect(removedWords('Vey', { schedules: 0, forgotten: { episodes: 0, facts: 0, plans: 0, blocks: 0, schedules: 0 } })).toBe('Vey was deleted; they had nothing to remember.');
  });

  it('leaves the character on the shelf when the store refuses, to try again', async () => {
    const shelf = new InMemoryCharacterShelf([ownCharacter('Vey', 'u-vey-aaaa')]);
    const memory = new FakeMemoryStore();
    memory.forgetCharacter = () => Promise.reject(new Error('the companion is not running'));
    await expect(removeCharacter('u-vey-aaaa', { shelf, memory, forget: true })).rejects.toThrow('the companion is not running');
    expect((await shelf.list()).map((kept) => kept.persona.id)).toEqual(['u-vey-aaaa']);
  });

  it('with no memory to forget from, takes it off the shelf and says nothing was forgotten', async () => {
    const shelf = new InMemoryCharacterShelf([ownCharacter('Vey', 'u-vey-aaaa')]);
    expect(await removeCharacter('u-vey-aaaa', { shelf, memory: null, forget: true })).toEqual({ schedules: 0, forgotten: null });
    expect(await shelf.list()).toEqual([]);
  });
});
