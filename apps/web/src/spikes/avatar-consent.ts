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
 */

export interface AssetDownload {
  readonly label: string;
  /** SPDX where there is one, and the honest name where there is not. */
  readonly licence: string;
  /** Exact bytes, not an estimate. */
  readonly bytes: number;
  readonly sourceUrl: string;
  readonly downloadUrl: string;
  /** Who to credit, even when the licence says credit is unnecessary. */
  readonly author: string;
  /** What the licence actually permits, in one line, for the person deciding. */
  readonly terms: string;
}

const RAW = 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages';

export const AVATAR: AssetDownload = {
  label: 'VRM1_Constraint_Twist_Sample (placeholder character)',
  licence: 'VRM Public License 1.0 — not Creative Commons',
  bytes: 10_776_032,
  sourceUrl: 'https://github.com/pixiv/three-vrm',
  downloadUrl: `${RAW}/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm`,
  author: 'pixiv Inc. — (c) 2022',
  terms: 'Use by anyone, redistribution and modification allowed, credit not required.',
};

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
