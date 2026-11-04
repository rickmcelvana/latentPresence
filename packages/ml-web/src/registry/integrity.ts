import type { PinnedFile } from './pins';

/**
 * The check every download passes (P9-T05, ADR-70): the bytes are the ones this build names.
 *
 * `crypto.subtle` exists only in a secure context. Served over plain `http://` it is absent, and
 * the check falls back to the size alone. That gives up nothing: on such a page whoever could
 * swap a model could swap the code doing the checking too. No secure context also means no
 * microphone or WebGPU, so what reaches this path in practice is the body.
 */

/** The hex digest, or null where this context has no `crypto.subtle`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What is wrong with these bytes, in a sentence; null when they are what was pinned. */
export async function integrityProblem(bytes: Uint8Array, file: PinnedFile, label: string): Promise<string | null> {
  if (bytes.length !== file.bytes) return `${label}: downloaded ${bytes.length} bytes, catalog says ${file.bytes}`;
  const actual = await sha256Hex(bytes);
  if (actual !== null && actual !== file.sha256) {
    return `${label}: these are not the bytes this app pinned (SHA-256 ${actual}, expected ${file.sha256})`;
  }
  return null;
}
