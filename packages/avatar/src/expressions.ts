import { type ExpressionName, type ExpressionWeights, ExpressionNameSchema } from '@latentpresence/protocol';

/**
 * From the names the affect engine speaks to the expressions a loaded model actually has.
 *
 * `ExpressionNameSchema` is the VRM 1.0 emotion presets plus a handful of ARKit-style
 * names the character pipeline (P7) will produce. A model has whatever its author gave
 * it: every VRM 1.0 model has the presets (possibly unbound, which is harmless), a
 * pipeline-built one also carries ARKit blend shapes as custom expressions, and the
 * placeholder has none of them. So each name is an ordered list of candidates, and the
 * **plan** is resolved once per loaded model rather than looked up per frame.
 *
 * Two rules decide the table:
 *
 * - **Passthrough first.** An ARKit name goes to the model's own shape of that name, or
 *   to its `Left`/`Right` pair — ARKit has no unsided `cheekSquint`, so the pair *is*
 *   the shape. Matching ignores case, because exporters disagree about `BrowInnerUp`.
 * - **A fallback only where the face means the same thing.** A model with no
 *   `mouthSmile` gets half a `happy`, since a smile is most of what `happy` draws. Brows,
 *   squints and cheeks have no preset that means them, so on a preset-only model they do
 *   nothing — a wrong expression reads worse than a missing one.
 */

/** One model expression a name drives, and how much of the requested weight it gets. */
export interface ExpressionTarget {
  readonly name: string;
  readonly scale: number;
}

interface Candidates {
  /** Tried first; every one present is driven at full weight. */
  readonly passthrough: readonly string[];
  /** Used only if no passthrough candidate exists on the model. */
  readonly fallback: readonly ExpressionTarget[];
}

function sided(base: string): readonly string[] {
  return [`${base}Left`, `${base}Right`];
}

/**
 * The mapping table. `satisfies Record<ExpressionName, …>` is load-bearing, as it is for
 * visemes: a name added to the protocol fails the build here instead of silently doing
 * nothing on every model.
 */
export const EXPRESSION_TABLE = {
  neutral: { passthrough: ['neutral'], fallback: [] },
  happy: { passthrough: ['happy'], fallback: [] },
  angry: { passthrough: ['angry'], fallback: [] },
  sad: { passthrough: ['sad'], fallback: [] },
  relaxed: { passthrough: ['relaxed'], fallback: [] },
  surprised: { passthrough: ['surprised'], fallback: [] },

  browInnerUp: { passthrough: ['browInnerUp'], fallback: [] },
  browDownLeft: { passthrough: ['browDownLeft'], fallback: [] },
  browDownRight: { passthrough: ['browDownRight'], fallback: [] },
  cheekSquint: { passthrough: ['cheekSquint', ...sided('cheekSquint')], fallback: [] },
  mouthSmile: {
    passthrough: ['mouthSmile', ...sided('mouthSmile')],
    fallback: [{ name: 'happy', scale: 0.5 }],
  },
  mouthFrown: {
    passthrough: ['mouthFrown', ...sided('mouthFrown')],
    fallback: [{ name: 'sad', scale: 0.5 }],
  },
  eyeSquint: { passthrough: ['eyeSquint', ...sided('eyeSquint')], fallback: [] },
  eyeWide: {
    passthrough: ['eyeWide', ...sided('eyeWide')],
    fallback: [{ name: 'surprised', scale: 0.5 }],
  },
} as const satisfies Record<ExpressionName, Candidates>;

/** What each protocol name drives on one particular model. Empty means "nothing". */
export type ExpressionPlan = ReadonlyMap<ExpressionName, readonly ExpressionTarget[]>;

/**
 * Resolve the table against the expression names a model has.
 *
 * Returns the model's own spelling, so the renderer can pass it straight to three-vrm.
 */
export function resolveExpressionPlan(available: Iterable<string>): ExpressionPlan {
  const byLowerCase = new Map<string, string>();
  for (const name of available) {
    // First spelling wins; a model with both `happy` and `Happy` is its author's problem,
    // and picking one deterministically is better than driving both.
    if (!byLowerCase.has(name.toLowerCase())) byLowerCase.set(name.toLowerCase(), name);
  }
  const find = (name: string): string | undefined => byLowerCase.get(name.toLowerCase());

  const plan = new Map<ExpressionName, readonly ExpressionTarget[]>();
  for (const name of ExpressionNameSchema.options) {
    const candidates: Candidates = EXPRESSION_TABLE[name];
    const direct = candidates.passthrough
      .map(find)
      .filter((found): found is string => found !== undefined)
      .map((found) => ({ name: found, scale: 1 }));
    if (direct.length > 0) {
      // An unsided shape and its pair both present: drive the unsided one only, or the
      // same smile is applied twice.
      const unsided = direct.find((target) => target.name.toLowerCase() === name.toLowerCase());
      plan.set(name, unsided === undefined ? direct : [unsided]);
      continue;
    }
    plan.set(
      name,
      candidates.fallback.flatMap((target) => {
        const found = find(target.name);
        return found === undefined ? [] : [{ name: found, scale: target.scale }];
      }),
    );
  }
  return plan;
}

/** Every model expression the plan can drive — the set `weightsFor` always writes. */
export function plannedTargets(plan: ExpressionPlan): ReadonlySet<string> {
  const names = new Set<string>();
  for (const targets of plan.values()) for (const target of targets) names.add(target.name);
  return names;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The model weights for one call to `setExpression`.
 *
 * `ExpressionWeights` is the set being driven *right now*, so a name left out is zero —
 * and every target the plan knows is written, including the zeros, or a smile from the
 * last call would never let go. Two names landing on one target (`happy` and a fallback
 * `mouthSmile`) take the larger weight rather than the sum, so the face never saturates
 * past what either asked for.
 */
export function weightsFor(plan: ExpressionPlan, weights: ExpressionWeights): Map<string, number> {
  const out = new Map<string, number>();
  for (const name of plannedTargets(plan)) out.set(name, 0);
  for (const [name, targets] of plan) {
    const requested = clampUnit(weights[name] ?? 0);
    if (requested === 0) continue;
    for (const target of targets) {
      const value = requested * target.scale;
      if (value > (out.get(target.name) ?? 0)) out.set(target.name, value);
    }
  }
  return out;
}
