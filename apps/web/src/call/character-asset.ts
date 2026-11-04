import { BODY_FILE, BODY_SOURCE, pinnedFile, pinnedUrl } from '@latentpresence/ml-web/registry';
import type { ModelDescriptor } from '@latentpresence/protocol';

/**
 * The avatar's asset facts (P2-T06), moved here from `spikes/avatar-consent.ts` so the
 * call layout can gate the fetch behind `ModelConsent` — the same `latentpresence.consent.v1`
 * store the voice models use — rather than the dev page's own "Agree and download" button.
 * `spikes/avatar-consent.ts` re-exports `AVATAR` from here, unchanged, so `/dev/avatar` and
 * `/spike/avatar` keep working without edits.
 *
 * Sizes and licence terms were read out of the file itself on 2026-09-09, from the
 * embedded `VRMC_vrm.meta`, and are recorded in `docs/SURFACE.md`.
 */

export interface AssetDownload {
  readonly label: string;
  /** SPDX where there is one, and the honest name where there is not. */
  readonly licence: string;
  /** Exact bytes, not an estimate. */
  readonly bytes: number;
  readonly sourceUrl: string;
  /** Names a commit, so it cannot move (ADR-70). */
  readonly downloadUrl: string;
  readonly sha256: string;
  /** Who to credit, even when the licence says credit is unnecessary. */
  readonly author: string;
  /** What the licence actually permits, in one line, for the person deciding. */
  readonly terms: string;
}

export const AVATAR: AssetDownload = {
  label: 'VRM1_Constraint_Twist_Sample (placeholder character)',
  licence: 'VRM Public License 1.0 — not Creative Commons',
  bytes: pinnedFile(BODY_SOURCE, BODY_FILE).bytes,
  sourceUrl: 'https://github.com/pixiv/three-vrm',
  downloadUrl: pinnedUrl(BODY_SOURCE, BODY_FILE),
  sha256: pinnedFile(BODY_SOURCE, BODY_FILE).sha256,
  author: 'pixiv Inc. — (c) 2022',
  terms: 'Use by anyone, redistribution and modification allowed, credit not required.',
};

/**
 * `AVATAR` as a `ModelDescriptor`, for `ModelConsent` and `cachedModelFetch` — both speak
 * descriptors, not `AssetDownload`s, and consent is per `id`. This is not a model in the
 * ML sense, but `ModelConsent` only ever looks at `id` and `sizeBytes`, so one descriptor
 * for the character costs nothing and keeps it in the same "what has this browser agreed
 * to" ledger as the voice.
 */
export const AVATAR_DESCRIPTOR: ModelDescriptor = {
  id: 'pixiv/VRM1_Constraint_Twist_Sample.vrm',
  label: AVATAR.label,
  sizeBytes: AVATAR.bytes,
  licence: AVATAR.licence,
  sourceUrl: AVATAR.sourceUrl,
};
