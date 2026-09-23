/**
 * What Spike B fetches, and what the screen says before it does.
 *
 * Separate from `consent.ts` because these are not models and the licence question is a
 * different one. ADR-09 says nothing downloads without size, licence and source on
 * screen; ADR-11 says assets should be CC0 or CC-BY. **This avatar is neither** — it
 * carries the VRM Public License 1.0 — which is exactly why it is fetched at run time
 * instead of being committed, and why the screen names the licence rather than implying
 * a friendly one.
 *
 * Sizes and licence terms were read out of the files themselves on 2026-09-09, from the
 * embedded `VRMC_vrm.meta`, and are recorded in `docs/SURFACE.md`.
 *
 * **`AVATAR` moved to `../call/character-asset.ts` at P2-T06**, so the call layout can
 * gate it with `ModelConsent` the way the voice models are gated. Re-exported here
 * unchanged so this page and `/spike/avatar` need no edits.
 */

import { AVATAR, type AssetDownload } from '../call/character-asset';

export { AVATAR };
export type { AssetDownload };

const RAW = 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages';

export const IDLE_CLIP: AssetDownload = {
  label: 'test.vrma (animation loader check, not an idle)',
  licence: 'MIT, with the repository',
  bytes: 11_548,
  sourceUrl: 'https://github.com/pixiv/three-vrm',
  downloadUrl: `${RAW}/three-vrm-animation/examples/models/test.vrma`,
  author: 'pixiv Inc.',
  terms: 'Three animation channels. It proves the VRMA path and nothing about how an idle looks.',
};

export const AVATAR_ASSETS: readonly AssetDownload[] = [AVATAR, IDLE_CLIP];

export function totalAssetBytes(assets: readonly AssetDownload[]): number {
  return assets.reduce((sum, asset) => sum + asset.bytes, 0);
}
