import { PersonaSchema, type Persona } from '@latentpresence/protocol';
import alice from '../../../../personas/alice.persona.json' with { type: 'json' };
import theo from '../../../../personas/theo.persona.json' with { type: 'json' };
import { BUILT_IN_BODIES, PLACEHOLDER_BODY_ID, THEO_BODY_ID } from './bodies';
import { isOwnBodyId } from './body-shelf';
import type { StoredCharacter } from './character-shelf';

/**
 * The characters (P6-T06, ADR-55; P11-T01, ADR-74). A pack is a persona plus the body it wears
 * when nothing is chosen. Alice and Theo ship as files at the repo root; the person's own are kept
 * on their `CharacterShelf`, and the list the page shows is both (`charactersFrom`, read through
 * `useCharacters`). The persona is the protocol's, unchanged; the body is the app's business, and
 * since P7-T02 (ADR-59) the person's choice per character, so the pack only says the default.
 *
 * **The persona's `id` is the memory namespace**, one database holding every character apart.
 */
export interface CharacterPack {
  readonly persona: Persona;
  /** A built-in body's id (`BUILT_IN_BODIES`), or for the person's own characters an own body's. */
  readonly defaultBody: string;
  /** Alice and Theo: duplicated, never edited (ADR-74 item 4). */
  readonly builtIn: boolean;
}

/** Parsed at module load: the files are editable by anyone with a text editor and no
 * typechecker, so a typo is a loud failure at startup. */
export const BUILT_IN_PACKS: readonly CharacterPack[] = [
  // The placeholder is Rick's call for Alice (ADR-18 amended), Theo's own body also his (ADR-59 amended).
  { persona: PersonaSchema.parse(alice), defaultBody: PLACEHOLDER_BODY_ID, builtIn: true },
  { persona: PersonaSchema.parse(theo), defaultBody: THEO_BODY_ID, builtIn: true },
];

export const DEFAULT_CHARACTER_ID = 'alice';

/** Who an unknown, missing or deleted id is, and who the dev pages and first-load migrations mean. */
export const ALICE: CharacterPack = BUILT_IN_PACKS.find((pack) => pack.persona.id === DEFAULT_CHARACTER_ID) ?? (BUILT_IN_PACKS[0] as CharacterPack);

export function isBuiltInCharacter(id: string): boolean {
  return BUILT_IN_PACKS.some((pack) => pack.persona.id === id);
}

/** Everyone the person can talk to, as the page knows it right now. */
export interface Characters {
  /** Alice and Theo first, then the person's own by name. */
  readonly packs: readonly CharacterPack[];
  /** The pack for a saved id; an unknown, missing or deleted one is Alice's. */
  packFor(id: string | null | undefined): CharacterPack;
  /**
   * False until the shelf has been read. Until then only the built-ins are listed, and a saved id
   * of the person's own must not be taken for Alice: whoever mounts a conversation waits.
   */
  readonly ready: boolean;
}

function ownPack(character: StoredCharacter): CharacterPack {
  // A built-in body that is no longer in the library (an id from an older app) wears the placeholder;
  // an own body is checked where the shelf is read (`bodyFor`), as a saved choice is.
  const known = isOwnBodyId(character.defaultBody) || BUILT_IN_BODIES.some((body) => body.id === character.defaultBody);
  return { persona: character.persona, defaultBody: known ? character.defaultBody : PLACEHOLDER_BODY_ID, builtIn: false };
}

/** The list from the shelf's characters; null while it has not been read. */
export function charactersFrom(own: readonly StoredCharacter[] | null): Characters {
  const packs = [...BUILT_IN_PACKS, ...(own ?? []).map(ownPack).toSorted((a, b) => a.persona.name.localeCompare(b.persona.name) || a.persona.id.localeCompare(b.persona.id))];
  return {
    packs,
    packFor: (id) => packs.find((pack) => pack.persona.id === id) ?? ALICE,
    ready: own !== null,
  };
}

/** Alice and Theo alone, for a component no one has given the person's characters (a test, a dev page). */
export const BUILT_IN_CHARACTERS: Characters = charactersFrom([]);
