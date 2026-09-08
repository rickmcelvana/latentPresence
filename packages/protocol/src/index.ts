/**
 * Shared types and schemas. Provider interfaces, affect and conversation types and
 * the companion API schema land here in P0-T02; this package is the one every other
 * package depends on, so the scaffold gives it the smallest real surface that the
 * workspace wiring can be tested against.
 *
 * Interfaces in this package change only in architect-owned tasks (CLAUDE.md).
 */

/** Bumped when a shipped interface in this package changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** What a workspace package reports about itself. */
export interface PackageInfo {
  readonly name: string;
  readonly protocolVersion: number;
}

export function describePackage(name: string): PackageInfo {
  return { name, protocolVersion: PROTOCOL_VERSION };
}
