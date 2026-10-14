import { PersonaSchema, type Persona } from '@latentpresence/protocol';
import alice from '../../../../personas/alice.persona.json' with { type: 'json' };
import theo from '../../../../personas/theo.persona.json' with { type: 'json' };
import { PLACEHOLDER_BODY_ID } from './bodies';

/**
 * The characters the app ships (P6-T06, ADR-55). A pack is a persona file at the repo root
 * plus the app's own entry naming its default body: no protocol change, because what the
 * companion or memory will read is still the persona, and the body is the app's business. Since
 * P7-T02 (ADR-59) the body is the person's choice per character from the library (`bodies.ts`);
 * the pack only says which one to wear when nothing is chosen.
 *
 * **The persona's `id` is the memory namespace** — it goes wherever `defaultPersona.id` went
 * before, into one database that holds every character apart.
 */
export interface CharacterPack {
  readonly persona: Persona;
  /** A built-in body's id (`BUILT_IN_BODIES`). */
  readonly defaultBody: string;
}

/** Parsed at module load, as `default-persona.ts` always has: the files are editable by anyone
 * with a text editor and no typechecker, so a typo is a loud failure at startup. */
export const PACKS: readonly CharacterPack[] = [alice, theo].map((file) => ({
  persona: PersonaSchema.parse(file),
  // Both wear the placeholder unless the person chooses otherwise: Rick's call for Alice (ADR-18 amended).
  defaultBody: PLACEHOLDER_BODY_ID,
}));

export const DEFAULT_CHARACTER_ID = 'alice';

const ALICE: CharacterPack = PACKS.find((pack) => pack.persona.id === DEFAULT_CHARACTER_ID) ?? (PACKS[0] as CharacterPack);

/** The pack for a saved id; an unknown, missing or removed one is Alice's. */
export function packFor(id: string | null | undefined): CharacterPack {
  return PACKS.find((pack) => pack.persona.id === id) ?? ALICE;
}
