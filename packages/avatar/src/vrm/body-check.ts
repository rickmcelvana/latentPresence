/**
 * What a body must have to stand in the call, and what it is missing (P7-T02, ADR-59).
 *
 * A body without the bones the renderer drives is refused, with the reason: the life layer,
 * the clips and the camera all read the humanoid rig, and a model missing its arms would load
 * as a statue with the camera framed on nothing. A body without some expressions is not: it
 * loads with what it has, and the report says what will not show (no blink, no visemes, no
 * smile) so the person choosing it knows before they wear it.
 *
 * Narrow types on purpose, as `face.ts` has: a real three-vrm `VRM` satisfies them, and so does
 * a plain object in a test, with no WebGL and no model file.
 */

/** The humanoid bones VRM 1.0 requires of every model (three-vrm's `VRMRequiredHumanBoneName`). */
export const REQUIRED_BONES = [
  'hips',
  'spine',
  'head',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
] as const;

/** The VRM presets the call drives: her eyelids, the five mouth shapes, the five emotions. */
export const CALL_PRESETS = ['blink', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;

export interface BodyReport {
  /** The model's own name from its `meta`, or null when it gives none. */
  readonly name: string | null;
  readonly authors: readonly string[];
  /** VRM 1.0's `licenseUrl`, or 0.x's licence name; null when the file says nothing. */
  readonly licence: string | null;
  /** Presets from `CALL_PRESETS` this body lacks. It loads without them. */
  readonly missing: readonly string[];
  /** Whether its eyes can follow the person (`lookAt`). */
  readonly lookAt: boolean;
}

/** VRM 1.0's meta and 0.x's, as far as the report reads them. */
interface MetaLike {
  readonly metaVersion?: string;
  readonly name?: string;
  readonly authors?: readonly string[];
  readonly licenseUrl?: string;
  readonly title?: string;
  readonly author?: string;
  readonly licenseName?: string;
}

export interface CheckedVrm {
  readonly humanoid?: { getRawBoneNode(name: (typeof REQUIRED_BONES)[number]): unknown } | null | undefined;
  readonly expressionManager?: { readonly expressionMap: Readonly<Record<string, unknown>> } | null | undefined;
  readonly lookAt?: unknown;
  readonly meta?: MetaLike | null | undefined;
}

/** A file the call cannot use, with the reason in words the picker shows as they are. */
export class BodyRejectedError extends Error {
  override readonly name = 'BodyRejectedError';
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Checks a loaded VRM. Throws `BodyRejectedError` naming the bones a body lacks; otherwise
 * returns what it is and what it cannot show.
 */
export function checkBody(vrm: CheckedVrm): BodyReport {
  const humanoid = vrm.humanoid;
  if (humanoid === null || humanoid === undefined) throw new BodyRejectedError('This model has no humanoid rig, so it cannot move.');
  const missingBones = REQUIRED_BONES.filter((bone) => humanoid.getRawBoneNode(bone) === null || humanoid.getRawBoneNode(bone) === undefined);
  if (missingBones.length > 0) {
    throw new BodyRejectedError(`This model is missing bones every VRM body needs: ${missingBones.join(', ')}.`);
  }

  // Exporters disagree about case (`Blink`, `A`), and three-vrm keeps a 0.x model's own names.
  const names = new Set(Object.keys(vrm.expressionManager?.expressionMap ?? {}).map((name) => name.toLowerCase()));
  const missing = CALL_PRESETS.filter((preset) => !names.has(preset));

  const meta = vrm.meta ?? {};
  const v0 = meta.metaVersion === '0';
  return {
    name: present(v0 ? meta.title : meta.name),
    authors: (v0 ? [meta.author] : (meta.authors ?? [])).map(present).filter((author): author is string => author !== null),
    licence: present(v0 ? meta.licenseName : meta.licenseUrl),
    missing,
    lookAt: vrm.lookAt !== null && vrm.lookAt !== undefined,
  };
}
