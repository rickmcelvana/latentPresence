import type { ModelDescriptor } from '@latentpresence/protocol';
import { AVATAR, AVATAR_DESCRIPTOR, THEO_BODY, THEO_BODY_DESCRIPTOR, type AssetDownload } from '../call/character-asset';
import { isOwnBodyId, type BodyShelf, type OwnBody } from './body-shelf';

/**
 * The body library (P7-T02, ADR-59). A character's body is a setting, like its voice: one of
 * the built-in bodies, downloaded only through the consent screen, or one of the person's own
 * `.vrm` files from the shelf. A pack names its default.
 */

export interface BuiltInBody {
  readonly id: string;
  readonly name: string;
  readonly asset: AssetDownload;
  readonly descriptor: ModelDescriptor;
}

export const PLACEHOLDER_BODY_ID = 'placeholder';
export const THEO_BODY_ID = 'theo-vroid';

export const BUILT_IN_BODIES: readonly BuiltInBody[] = [
  { id: PLACEHOLDER_BODY_ID, name: 'The placeholder (pixiv sample)', asset: AVATAR, descriptor: AVATAR_DESCRIPTOR },
  { id: THEO_BODY_ID, name: 'Theo (VRoid Studio model)', asset: THEO_BODY, descriptor: THEO_BODY_DESCRIPTOR },
  // The generated Alice (P7-T02) was taken out on 2026-10-16: not good enough to ship. A saved
  // `alice-generated` choice falls back to the pack's default, as any unknown id does.
];

/** What the stage loads: a download behind consent, or a file already on this computer. */
export type StageBody =
  | { readonly kind: 'download'; readonly id: string; readonly name: string; readonly asset: AssetDownload; readonly descriptor: ModelDescriptor }
  | { readonly kind: 'local'; readonly id: string; readonly name: string; read(): Promise<Uint8Array> };

export function builtInStageBody(body: BuiltInBody): StageBody {
  return { kind: 'download', id: body.id, name: body.name, asset: body.asset, descriptor: body.descriptor };
}

function builtIn(id: string): BuiltInBody | undefined {
  return BUILT_IN_BODIES.find((body) => body.id === id);
}

/** What a person agrees to when a pack's default body is the one that will download. */
export function defaultBodyDescriptor(defaultId: string): ModelDescriptor {
  return (builtIn(defaultId) ?? (BUILT_IN_BODIES[0] as BuiltInBody)).descriptor;
}

/**
 * The body to wear: the saved choice, else the pack's default. An own body is worn from the
 * shelf; while the shelf has not been listed yet (`own` null) it is taken on trust, and once it
 * has, one that is no longer there falls back to the default, as an unknown id does.
 */
export function bodyFor(saved: string | null, defaultId: string, shelf: BodyShelf, own: readonly OwnBody[] | null): StageBody {
  const wear = (id: string | null): StageBody | null => {
    if (id === null) return null;
    const found = builtIn(id);
    if (found !== undefined) return builtInStageBody(found);
    if (!isOwnBodyId(id)) return null;
    const kept = own?.find((body) => body.id === id);
    return own === null || kept !== undefined ? { kind: 'local', id, name: kept?.name ?? 'Your own body', read: () => shelf.read(id) } : null;
  };
  // A character of the person's own may default to one of their own bodies (P11-T01, ADR-74 item 1).
  return wear(saved) ?? wear(defaultId) ?? builtInStageBody(BUILT_IN_BODIES[0] as BuiltInBody);
}
