/**
 * @latentpresence/protocol — the shared vocabulary.
 *
 * Nothing here does work: no I/O, no DOM, no audio, no timers. It is the types, the
 * zod schemas and the companion route table that every other package compiles against.
 * Interfaces in this package change only in architect-owned tasks with an ADR note.
 *
 * zod for anything that crosses a boundary (persisted, sent over HTTP or WS, saved in
 * settings, emitted by a model). Plain TypeScript for in-process values (audio buffers,
 * async iterables, renderer handles). See README.md.
 */

/** Bumped when a shipped interface in this package changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export * from './common';
export * from './media';
export * from './affect';
export * from './conversation';
export * from './schedule';
export * from './capabilities';
export * from './memory';
export * from './avatar';
export * from './companion';

export * from './providers/shared';
export * from './providers/llm';
export * from './providers/stt';
export * from './providers/tts';
export * from './providers/embedding';
export * from './providers/omni';
