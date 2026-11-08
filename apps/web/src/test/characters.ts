import type { Persona } from '@latentpresence/protocol';
import { PLACEHOLDER_BODY_ID } from '../characters/bodies';
import type { StoredCharacter } from '../characters/character-shelf';
import { ALICE } from '../characters/packs';

/** One of the person's own characters (P11-T01), as the editor (P11-T03) makes one: Alice's lines under a new name. */
export function ownCharacter(name: string, id: string, overrides: Partial<StoredCharacter> = {}): StoredCharacter {
  const persona: Persona = { ...ALICE.persona, id, name, summary: `${name} reads tarot cards for people who call.` };
  return { persona, defaultBody: PLACEHOLDER_BODY_ID, createdAt: '2026-11-08T10:00:00.000Z', updatedAt: '2026-11-08T10:00:00.000Z', ...overrides };
}
