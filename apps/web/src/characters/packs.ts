import { PersonaSchema, type ModelDescriptor, type Persona } from '@latentpresence/protocol';
import alice from '../../../../personas/alice.persona.json' with { type: 'json' };
import theo from '../../../../personas/theo.persona.json' with { type: 'json' };
import { AVATAR, AVATAR_DESCRIPTOR, type AssetDownload } from '../call/character-asset';

/**
 * The characters the app ships (P6-T06, ADR-55). A pack is a persona file at the repo root
 * plus the app's own entry naming its body: no protocol change, because what the companion
 * or memory will read is still the persona, and the body is the app's business until the
 * character pipeline (P7) gives each one its own.
 *
 * **The persona's `id` is the memory namespace** — it goes wherever `defaultPersona.id` went
 * before, into one database that holds every character apart.
 */
export interface CharacterPack {
  readonly persona: Persona;
  readonly avatar: AssetDownload;
  readonly avatarDescriptor: ModelDescriptor;
}

/** Parsed at module load, as `default-persona.ts` always has: the files are editable by anyone
 * with a text editor and no typechecker, so a typo is a loud failure at startup. */
export const PACKS: readonly CharacterPack[] = [alice, theo].map((file) => ({
  persona: PersonaSchema.parse(file),
  // Both wear the placeholder body until P7.
  avatar: AVATAR,
  avatarDescriptor: AVATAR_DESCRIPTOR,
}));

export const DEFAULT_CHARACTER_ID = 'alice';

const ALICE: CharacterPack = PACKS.find((pack) => pack.persona.id === DEFAULT_CHARACTER_ID) ?? (PACKS[0] as CharacterPack);

/** The pack for a saved id; an unknown, missing or removed one is Alice's. */
export function packFor(id: string | null | undefined): CharacterPack {
  return PACKS.find((pack) => pack.persona.id === id) ?? ALICE;
}
