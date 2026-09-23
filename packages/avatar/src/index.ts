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
export {
  EXPRESSION_TABLE,
  plannedTargets,
  resolveExpressionPlan,
  weightsFor,
  type ExpressionPlan,
  type ExpressionTarget,
} from './expressions';
export { gazeDirection, gazePoint, type GazeOffset, type Vec3 } from './gaze';
export * from './life';
export * from './lipsync';
export { FakeAvatarRenderer, MOUTH_SHAPES, applyViseme, type MouthShape } from './fake';

/** Keeps the workspace wiring under test. The renderer itself is `@latentpresence/avatar/vrm`. */
export const packageInfo = {
  name: '@latentpresence/avatar',
  protocolVersion: PROTOCOL_VERSION,
} as const;
