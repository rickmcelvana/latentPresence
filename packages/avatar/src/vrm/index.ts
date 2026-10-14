/**
 * The VRM renderer (P2-T01). A subpath of its own, so importing `@latentpresence/avatar`
 * for the mapping tables or the fake never pulls three.js into a bundle.
 */
export { AdditivePose } from './additive-pose';
export { ClipPlayer } from './clip-player';
export { VrmFaceDriver, type VrmFace } from './face';
export {
  SCREEN,
  STAGE_PALETTE,
  WHITEBOARD,
  WINDOW,
  buildStage,
  stageBoards,
  DEFAULT_STAGE_OPTIONS,
  type StageBoards,
  type StageDeps,
  type StageOptions,
} from './stage';
export { DisplayBoard, drawBoard, hexColour, type BoardCanvas, type BoardPalette, type CreateCanvas } from './display-board';
export { BodyRejectedError, CALL_PRESETS, REQUIRED_BONES, checkBody, type BodyReport, type CheckedVrm } from './body-check';
export { inspectBody, readVrm } from './inspect';
export {
  VrmAvatarRenderer,
  type DrawingSurface,
  type VrmRendererDeps,
  type VrmRendererOptions,
} from './renderer';
