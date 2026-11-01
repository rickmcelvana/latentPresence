import axe from 'axe-core';

/**
 * P9-T01: runs axe-core on a rendered container and fails with each violation's id, help
 * text and the selectors of the elements it flagged.
 *
 * Two rules are off, each because the container is not the thing the rule measures:
 * - `color-contrast`: jsdom has no layout or canvas, so axe cannot compute it (it reports
 *   "incomplete", never a pass). `contrast.test.ts` checks the theme tokens instead.
 * - `region`: "all page content should be in a landmark" is a rule about a whole page, and a
 *   component rendered alone has no page around it. The page-level landmarks (the main nav,
 *   the call layout) are asserted where the pages are tested.
 *
 * Every other rule runs, including the ones that are page-wide only when the page is in the
 * container (`landmark-*`, `heading-order`, `duplicate-id`).
 */
export async function expectAccessible(container: Element): Promise<void> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  if (results.violations.length === 0) return;
  const lines = results.violations.flatMap((violation) => [
    `${violation.id}: ${violation.help}`,
    ...violation.nodes.map((node) => `  ${node.target.join(' ')}  ${node.html}`),
  ]);
  throw new Error(`${results.violations.length} accessibility violation(s)\n${lines.join('\n')}`);
}
