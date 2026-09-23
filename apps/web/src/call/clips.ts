import type { BaseClip } from '@latentpresence/avatar';
import idleUrl from '../../../../assets/clips/idle.vrma?url';
import talkUrl from '../../../../assets/clips/talk.vrma?url';

/**
 * The body's base clips (P2-T03), served with the app rather than fetched from anywhere:
 * they are CC0, ~100 KB each, and built into `assets/clips/` by `pnpm clips:build` —
 * assets of ours, like the app's own code, so no consent screen stands in front of them.
 * `assets/clips/manifest.json` carries their source and licence.
 */
export const BASE_CLIP_URLS: Readonly<Record<BaseClip, string>> = {
  idle: idleUrl,
  talk: talkUrl,
};
