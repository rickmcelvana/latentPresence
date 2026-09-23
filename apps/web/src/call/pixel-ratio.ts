/**
 * The stage's drawing-buffer pixel ratio (P2-T06's responsive done-when): the device's
 * own ratio, capped at 2 so a 3x phone or a high-DPI laptop is not asked to rasterise a
 * frame for nothing an eye resolves, and never wide enough that the buffer exceeds
 * 3840 px — a 4K monitor at dpr 2 would otherwise want a 7680 px-wide buffer for a
 * full-viewport stage, most of a 4K GPU's frame budget spent on pixels nobody sees.
 *
 * Pure so it can be tested without a canvas: `CallStage` calls it on mount and again on
 * every resize, and hands the result to `VrmAvatarRenderer.setPixelRatio`.
 */
export function computePixelRatio(cssWidthPx: number, devicePixelRatio: number): number {
  const capped = Math.min(devicePixelRatio, 2);
  if (cssWidthPx <= 0) return capped;
  const bufferWidth = cssWidthPx * capped;
  return bufferWidth > 3840 ? 3840 / cssWidthPx : capped;
}
