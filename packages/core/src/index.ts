import { PROTOCOL_VERSION } from '@latentpresence/protocol';

/** Placeholder surface until this package is filled in. Keeps the wiring under test. */
export const packageInfo = {
  name: '@latentpresence/core',
  protocolVersion: PROTOCOL_VERSION,
} as const;

export * from './conversation';
export * from './chunker';
export * from './turn';
export * from './playback';
export * from './reply';
export * from './voice';
export { Cancellation } from './cancellation';
