import type { CancellationSignal } from '@latentpresence/protocol';

/**
 * Has this signal been aborted?
 *
 * A function rather than `signal?.aborted === true` written inline, because TypeScript
 * narrows a `readonly boolean` property and *keeps* the narrowing: after one check has
 * established `aborted` is false, every later check in the same scope is reported as
 * impossible (TS2367). The property is genuinely mutable from outside — that is the whole
 * point of a cancellation signal — so the narrowing is wrong, and a call boundary is the
 * cheapest way to stop it from happening. Checking repeatedly matters here: ADR-21 cancels
 * recognition *during* transcription, not only before it.
 */
export function isAborted(signal: CancellationSignal | undefined): boolean {
  return signal?.aborted === true;
}
