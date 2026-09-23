/**
 * The VRM renderer (P2-T01). A subpath of its own, so importing `@latentpresence/avatar`
 * for the mapping tables or the fake never pulls three.js into a bundle.
 */
export { AdditivePose } from './additive-pose';
export { ClipPlayer } from './clip-player';
export { VrmFaceDriver, type VrmFace } from './face';
export { STAGE_PALETTE, buildStage, DEFAULT_STAGE_OPTIONS, type StageOptions } from './stage';
export {
  VrmAvatarRenderer,
  type DrawingSurface,
  type VrmRendererDeps,
  type VrmRendererOptions,
} from './renderer';
