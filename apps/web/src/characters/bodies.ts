import type { ModelDescriptor } from '@latentpresence/protocol';
import { ALICE_GENERATED, ALICE_GENERATED_DESCRIPTOR, AVATAR, AVATAR_DESCRIPTOR, type AssetDownload } from '../call/character-asset';
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

export const BUILT_IN_BODIES: readonly BuiltInBody[] = [
  { id: PLACEHOLDER_BODY_ID, name: 'The placeholder (pixiv sample)', asset: AVATAR, descriptor: AVATAR_DESCRIPTOR },
  { id: 'alice-generated', name: 'Alice, generated', asset: ALICE_GENERATED, descriptor: ALICE_GENERATED_DESCRIPTOR },
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

/**
 * The body to wear: the saved choice, else the pack's default. An own body is worn from the
 * shelf; while the shelf has not been listed yet (`own` null) it is taken on trust, and once it
 * has, one that is no longer there falls back to the default, as an unknown id does.
 */
export function bodyFor(saved: string | null, defaultId: string, shelf: BodyShelf, own: readonly OwnBody[] | null): StageBody {
  const fallback = builtIn(defaultId) ?? (BUILT_IN_BODIES[0] as BuiltInBody);
  const id = saved ?? fallback.id;
  const found = builtIn(id);
  if (found !== undefined) return builtInStageBody(found);
  if (isOwnBodyId(id)) {
    const kept = own?.find((body) => body.id === id);
    if (own === null || kept !== undefined) return { kind: 'local', id, name: kept?.name ?? 'Your own body', read: () => shelf.read(id) };
  }
  return builtInStageBody(fallback);
}
