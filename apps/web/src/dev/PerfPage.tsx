import type { ReactElement } from 'react';
import { VrmAvatarRenderer } from '@latentpresence/avatar/vrm';
import type { FrameStats } from '@latentpresence/avatar/vrm';
import { ChatPage } from '../chat/ChatPage';

/**
 * `/dev/perf` (P9-T02, ADR-68): `/chat` exactly as a person gets it, with one difference —
 * the stage's renderer is kept, so Playwright can ask what a frame costs to draw
 * (`e2e/perf.spec.ts`). Dev-only, like every page in `src/dev`; `perfHandle` is one of the
 * names `vite.config.ts` refuses to find in a production chunk.
 */
export interface PerfHandle {
  /** The last frame's cost, or null before the stage has a surface. */
  stats(): FrameStats | null;
  /** Whether a body is on stage, so the spec measures her and not an empty room. */
  bodyLoaded(): boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var perfHandle: PerfHandle | undefined;
}

function measuredRenderer(): VrmAvatarRenderer {
  const renderer = new VrmAvatarRenderer();
  globalThis.perfHandle = { stats: () => renderer.frameStats(), bodyLoaded: () => renderer.bodyReport() !== null };
  return renderer;
}

export function PerfPage(): ReactElement {
  return <ChatPage createRenderer={measuredRenderer} />;
}
