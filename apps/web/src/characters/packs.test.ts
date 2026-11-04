import { PersonaSchema } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_BODIES, PLACEHOLDER_BODY_ID, THEO_BODY_ID } from './bodies';
import { DEFAULT_CHARACTER_ID, PACKS, packFor } from './packs';

describe('character packs (P6-T06, ADR-55)', () => {
  it('ships Alice first, then Theo', () => {
    expect(PACKS.map((pack) => pack.persona.id)).toEqual(['alice', 'theo']);
    expect(DEFAULT_CHARACTER_ID).toBe('alice');
  });

  it('has a persona that parses, for every pack', () => {
    for (const pack of PACKS) expect(PersonaSchema.safeParse(pack.persona).success, pack.persona.id).toBe(true);
  });

  it('has a unique id and name for every pack, since the id is the memory namespace', () => {
    expect(new Set(PACKS.map((pack) => pack.persona.id)).size).toBe(PACKS.length);
    expect(new Set(PACKS.map((pack) => pack.persona.name)).size).toBe(PACKS.length);
  });

  it('gives Alice the placeholder and Theo his own, each a body the library has (ADR-18, ADR-59 amended)', () => {
    expect(PACKS.map((pack) => pack.defaultBody)).toEqual([PLACEHOLDER_BODY_ID, THEO_BODY_ID]);
    for (const pack of PACKS) expect(BUILT_IN_BODIES.some((body) => body.id === pack.defaultBody)).toBe(true);
  });

  it('finds a pack by id, and falls back to Alice for an unknown, empty or missing one', () => {
    expect(packFor('theo').persona.name).toBe('Theo');
    expect(packFor('alice').persona.id).toBe('alice');
    expect(packFor('nobody').persona.id).toBe('alice');
    expect(packFor('').persona.id).toBe('alice');
    expect(packFor(null).persona.id).toBe('alice');
    expect(packFor(undefined).persona.id).toBe('alice');
  });
});
