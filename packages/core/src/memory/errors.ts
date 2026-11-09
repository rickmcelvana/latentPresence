import { OWN_CHARACTER_PREFIX, type CompanionError } from '@latentpresence/protocol';

/** What went wrong, in the companion's words (`CompanionErrorSchema`), so every store says it alike. */
export type MemoryStoreErrorCode = CompanionError['error']['code'];

/**
 * The one error every `MemoryStore` adapter throws for a refusal (P4-T04): an unknown id is
 * `not_found`, a plan saved over a newer version is `conflict`, a write the schema forbids (a
 * fact ending before it began) is `bad_request`, no database behind the companion is
 * `unavailable`. The conformance suite checks the code, not the words.
 */
export class MemoryStoreError extends Error {
  override readonly name = 'MemoryStoreError';
  readonly code: MemoryStoreErrorCode;

  constructor(code: MemoryStoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * `forgetCharacter` is for the person's own characters only (ADR-74 item 8): every adapter refuses
 * Alice, Theo and any id without the prefix the same way, before touching a row.
 */
export function refuseBuiltIn(characterId: string): void {
  if (!characterId.startsWith(OWN_CHARACTER_PREFIX) || characterId.length === OWN_CHARACTER_PREFIX.length) {
    throw new MemoryStoreError('bad_request', `"${characterId}" is not one of the characters you made, so it cannot be forgotten all at once; clear it in the Memory view instead.`);
  }
}
