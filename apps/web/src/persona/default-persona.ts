import type { Persona } from '@latentpresence/protocol';
import { DEFAULT_CHARACTER_ID, packFor } from '../characters/packs';

/**
 * The persona the app ships with (P1-T12): Alice, the first pack (P6-T06).
 *
 * Parsed, not trusted, in `characters/packs.ts` — the file is content at the repo root,
 * editable by anyone with a text editor and no typechecker, so the schema is the only thing
 * standing between a typo and a character with no boundaries. `/chat` now reads the active
 * pack's persona; this stays for what has only ever meant Alice (the dev pages, the tests).
 */
export const defaultPersona: Persona = packFor(DEFAULT_CHARACTER_ID).persona;
