import { PersonaSchema, type Persona } from '@latentpresence/protocol';
import alice from '../../../../personas/alice.persona.json' with { type: 'json' };

/**
 * The persona the app ships with (P1-T12).
 *
 * Parsed rather than trusted: the file is content at the repo root, editable by anyone
 * with a text editor and no typechecker, so the schema is the only thing standing between
 * a typo and a character with no boundaries. Parsing at module load makes a broken file a
 * loud failure at startup rather than a strange answer three turns in.
 *
 * Multiple personas, and choosing between them in settings, are not this task's (P1-T12).
 */
export const defaultPersona: Persona = PersonaSchema.parse(alice);
