import { PersonaSchema } from '@latentpresence/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_BODIES, PLACEHOLDER_BODY_ID, THEO_BODY_ID } from './bodies';
import { InMemoryCharacterShelf, IndexedDbCharacterShelf, isOwnCharacterId, newCharacterId, type CharacterShelf } from './character-shelf';
import { ownCharacter } from '../test/characters';
import { ALICE, BUILT_IN_CHARACTERS, BUILT_IN_PACKS, DEFAULT_CHARACTER_ID, charactersFrom, isBuiltInCharacter } from './packs';

/** Random bytes that are all zero, so a made id can be written down. */
const zero = (bytes: Uint8Array<ArrayBuffer>): Uint8Array => bytes.fill(0);

describe('character packs (P6-T06, ADR-55)', () => {
  it('ships Alice first, then Theo', () => {
    expect(BUILT_IN_PACKS.map((pack) => pack.persona.id)).toEqual(['alice', 'theo']);
    expect(DEFAULT_CHARACTER_ID).toBe('alice');
    expect(ALICE.persona.id).toBe('alice');
    expect(BUILT_IN_PACKS.every((pack) => pack.builtIn)).toBe(true);
  });

  it('has a persona that parses, for every pack', () => {
    for (const pack of BUILT_IN_PACKS) expect(PersonaSchema.safeParse(pack.persona).success, pack.persona.id).toBe(true);
  });

  it('has a unique id and name for every pack, since the id is the memory namespace', () => {
    expect(new Set(BUILT_IN_PACKS.map((pack) => pack.persona.id)).size).toBe(BUILT_IN_PACKS.length);
    expect(new Set(BUILT_IN_PACKS.map((pack) => pack.persona.name)).size).toBe(BUILT_IN_PACKS.length);
  });

  it('gives Alice the placeholder and Theo his own, each a body the library has (ADR-18, ADR-59 amended)', () => {
    expect(BUILT_IN_PACKS.map((pack) => pack.defaultBody)).toEqual([PLACEHOLDER_BODY_ID, THEO_BODY_ID]);
    for (const pack of BUILT_IN_PACKS) expect(BUILT_IN_BODIES.some((body) => body.id === pack.defaultBody)).toBe(true);
  });

  it('finds a pack by id, and falls back to Alice for an unknown, empty or missing one', () => {
    const { packFor } = BUILT_IN_CHARACTERS;
    expect(packFor('theo').persona.name).toBe('Theo');
    expect(packFor('alice').persona.id).toBe('alice');
    expect(packFor('nobody').persona.id).toBe('alice');
    expect(packFor('').persona.id).toBe('alice');
    expect(packFor(null).persona.id).toBe('alice');
    expect(packFor(undefined).persona.id).toBe('alice');
  });
});

describe('the person’s own characters (P11-T01, ADR-74)', () => {
  it('lists Alice and Theo first, then theirs by name, and finds theirs by id', () => {
    const list = charactersFrom([ownCharacter('Zara', 'u-zara-aaaa'), ownCharacter('Madame Vey', 'u-madame-vey-7k2q')]);
    expect(list.packs.map((pack) => pack.persona.name)).toEqual(['Alice', 'Theo', 'Madame Vey', 'Zara']);
    expect(list.packs.map((pack) => pack.builtIn)).toEqual([true, true, false, false]);
    expect(list.packFor('u-madame-vey-7k2q').persona.name).toBe('Madame Vey');
    expect(list.packFor('u-gone-0000').persona.id).toBe('alice');
    expect(list.ready).toBe(true);
  });

  it('is not ready, and lists only the built-ins, until the shelf has been read', () => {
    const list = charactersFrom(null);
    expect(list.ready).toBe(false);
    expect(list.packs.map((pack) => pack.persona.id)).toEqual(['alice', 'theo']);
    expect(BUILT_IN_CHARACTERS.ready).toBe(true);
  });

  it('keeps an own body as the default, and swaps a built-in one the library no longer has for the placeholder', () => {
    const list = charactersFrom([ownCharacter('Mine', 'u-mine-aaaa', { defaultBody: 'own:1234' }), ownCharacter('Old', 'u-old-aaaa', { defaultBody: 'alice-generated' })]);
    expect(list.packFor('u-mine-aaaa').defaultBody).toBe('own:1234');
    expect(list.packFor('u-old-aaaa').defaultBody).toBe(PLACEHOLDER_BODY_ID);
  });

  it('makes ids that start u-, read the name, and never meet a built-in one', () => {
    expect(newCharacterId('Madame Vey', zero)).toBe('u-madame-vey-aaaa');
    expect(newCharacterId('Zoë  the Bold!', zero)).toBe('u-zoe-the-bold-aaaa');
    expect(newCharacterId('???', zero)).toBe('u-character-aaaa');
    expect(newCharacterId('A name far longer than anyone would want to type', zero)).toBe('u-a-name-far-longer-than-a-aaaa');
    const made = newCharacterId('Alice');
    expect(made).toMatch(/^u-alice-[a-z2-9]{4}$/u);
    expect(isOwnCharacterId(made)).toBe(true);
    expect(isBuiltInCharacter(made)).toBe(false);
    expect(isOwnCharacterId('alice')).toBe(false);
    expect(isOwnCharacterId('u-')).toBe(false);
    expect(newCharacterId('Alice')).not.toBe(made);
  });
});

describe.each<[string, () => CharacterShelf]>([
  ['IndexedDbCharacterShelf', () => new IndexedDbCharacterShelf(new IDBFactory())],
  ['InMemoryCharacterShelf', () => new InMemoryCharacterShelf()],
])('%s (P11-T01)', (_name, make) => {
  it('keeps a character, replaces it by id, removes it, and tells listeners each time', async () => {
    const shelf = make();
    let told = 0;
    const stop = shelf.subscribe(() => (told += 1));
    const vey = ownCharacter('Madame Vey', 'u-madame-vey-7k2q');
    await shelf.put(vey);
    expect(await shelf.list()).toEqual([vey]);

    const renamed = { ...vey, persona: { ...vey.persona, name: 'Vey' } };
    await shelf.put(renamed);
    expect(await shelf.list()).toEqual([renamed]);

    await shelf.remove(vey.persona.id);
    expect(await shelf.list()).toEqual([]);
    expect(told).toBe(3);
    stop();
    await shelf.put(vey);
    expect(told).toBe(3);
  });

  it('refuses a built-in id and a persona that does not parse, keeping nothing', async () => {
    const shelf = make();
    await expect(shelf.put(ownCharacter('Alice again', 'alice'))).rejects.toThrow(/starting with u-/u);
    await expect(shelf.put(ownCharacter('', 'u-blank-aaaa'))).rejects.toThrow();
    expect(await shelf.list()).toEqual([]);
  });
});

describe('IndexedDbCharacterShelf', () => {
  it('lasts past a reload, and leaves out a record that no longer reads as a persona', async () => {
    const factory = new IDBFactory();
    const vey = ownCharacter('Madame Vey', 'u-madame-vey-7k2q');
    await new IndexedDbCharacterShelf(factory).put(vey);

    // Written by hand (an older app, a person in the devtools): the rest of the list still loads.
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('latentpresence-characters', 1);
      open.addEventListener('success', () => {
        const transaction = open.result.transaction('characters', 'readwrite');
        transaction.objectStore('characters').put({ persona: { id: 'u-broken-aaaa', name: 'Broken' } });
        transaction.addEventListener('complete', () => resolve());
        transaction.addEventListener('error', () => reject(transaction.error));
      });
    });

    expect(await new IndexedDbCharacterShelf(factory).list()).toEqual([vey]);
  });
});
