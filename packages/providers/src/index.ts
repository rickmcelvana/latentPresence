import { PROTOCOL_VERSION } from '@latentpresence/protocol';

/** Placeholder surface until this package is filled in. Keeps the wiring under test. */
export const packageInfo = {
  name: '@latentpresence/providers',
  protocolVersion: PROTOCOL_VERSION,
} as const;

export * from './access';
export * from './llm';
export * from './memory';
export * from './stt';
export * from './tts';
export * from './turn';
export * from './ser';
export * from './face';
export * from './audio';
export * from './mcp';
export * from './ingest';
