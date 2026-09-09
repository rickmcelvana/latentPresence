import { PROTOCOL_VERSION } from '@latentpresence/protocol';

export {
  OCULUS_VISEMES,
  VISEME_MAP,
  VRM_VISEMES,
  smoothWeight,
  toVrmViseme,
  visemeWeight,
  type OculusViseme,
} from './visemes';

/** Placeholder surface until this package is filled in. Keeps the wiring under test. */
export const packageInfo = {
  name: '@latentpresence/avatar',
  protocolVersion: PROTOCOL_VERSION,
} as const;
