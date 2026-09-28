import type { CompanionError } from '@latentpresence/protocol';

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
