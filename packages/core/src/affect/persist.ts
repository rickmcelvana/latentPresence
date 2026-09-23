import { AffectStateSchema, type AffectState } from '@latentpresence/protocol';
import { advanceAffect } from './engine';
import { DEFAULT_AFFECT_PARAMS, type AffectParams } from './params';

/**
 * Affect across sessions (P3-T01; P4 stores it in MariaDB). The state is plain JSON — the
 * protocol's `AffectState` — so saving is `JSON.stringify` and loading is the schema's
 * parse, which refuses a mood outside its range rather than letting a corrupt row in.
 *
 * **Restoring advances the gap.** A character saved in a temper and opened a week later is
 * back at her baseline; one opened a minute later still carries the feeling. That is the
 * point of persisting a *decaying* state rather than a snapshot.
 */

export function serializeAffect(state: AffectState): string {
  return JSON.stringify(state);
}

/** Parse and validate a saved state; throws on anything the schema refuses. */
export function parseAffect(text: string): AffectState {
  return AffectStateSchema.parse(JSON.parse(text));
}

/** Parse, then bring the state up to `now` as if it had been running all along. */
export function restoreAffect(text: string, now: number, params: AffectParams = DEFAULT_AFFECT_PARAMS): AffectState {
  return advanceAffect(parseAffect(text), now, params);
}
