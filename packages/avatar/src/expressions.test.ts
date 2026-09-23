import { describe, expect, it } from 'vitest';
import { ExpressionNameSchema } from '@latentpresence/protocol';
import { plannedTargets, resolveExpressionPlan, weightsFor } from './expressions';

const PRESETS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const MOUTH_AND_EYES = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight'];

describe('resolveExpressionPlan', () => {
  it('maps every VRM preset to itself on a preset-only model', () => {
    const plan = resolveExpressionPlan([...PRESETS, ...MOUTH_AND_EYES]);
    for (const preset of ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const) {
      expect(plan.get(preset)).toEqual([{ name: preset, scale: 1 }]);
    }
  });

  it('covers every protocol name, so a new one cannot be silently unmapped', () => {
    const plan = resolveExpressionPlan([]);
    expect([...plan.keys()].toSorted()).toEqual(ExpressionNameSchema.options.toSorted());
  });

  it('passes an ARKit name through to the sided pair when the model has one', () => {
    const plan = resolveExpressionPlan([...PRESETS, 'mouthSmileLeft', 'mouthSmileRight']);
    expect(plan.get('mouthSmile')).toEqual([
      { name: 'mouthSmileLeft', scale: 1 },
      { name: 'mouthSmileRight', scale: 1 },
    ]);
  });

  it('prefers an unsided shape over its pair, so one smile is not applied twice', () => {
    const plan = resolveExpressionPlan(['mouthSmile', 'mouthSmileLeft', 'mouthSmileRight']);
    expect(plan.get('mouthSmile')).toEqual([{ name: 'mouthSmile', scale: 1 }]);
  });

  it("matches regardless of case and returns the model's own spelling", () => {
    const plan = resolveExpressionPlan(['Happy', 'BrowInnerUp']);
    expect(plan.get('happy')).toEqual([{ name: 'Happy', scale: 1 }]);
    expect(plan.get('browInnerUp')).toEqual([{ name: 'BrowInnerUp', scale: 1 }]);
  });

  it('falls back to half a preset only where the face means the same thing', () => {
    const plan = resolveExpressionPlan(PRESETS);
    expect(plan.get('mouthSmile')).toEqual([{ name: 'happy', scale: 0.5 }]);
    expect(plan.get('mouthFrown')).toEqual([{ name: 'sad', scale: 0.5 }]);
    expect(plan.get('eyeWide')).toEqual([{ name: 'surprised', scale: 0.5 }]);
    // No preset means a brow, a squint or a cheek: those do nothing rather than the wrong thing.
    for (const name of ['browInnerUp', 'browDownLeft', 'cheekSquint', 'eyeSquint'] as const) {
      expect(plan.get(name)).toEqual([]);
    }
  });

  it('does not fall back when the passthrough exists', () => {
    const plan = resolveExpressionPlan([...PRESETS, 'mouthSmile']);
    expect(plan.get('mouthSmile')).toEqual([{ name: 'mouthSmile', scale: 1 }]);
  });

  it('never plans a viseme or a blink, which belong to other channels', () => {
    const targets = plannedTargets(resolveExpressionPlan([...PRESETS, ...MOUTH_AND_EYES]));
    for (const reserved of MOUTH_AND_EYES) expect(targets.has(reserved)).toBe(false);
  });
});

describe('weightsFor', () => {
  const plan = resolveExpressionPlan(PRESETS);

  it('writes zero to every planned target that was not asked for', () => {
    const weights = weightsFor(plan, { happy: 0.6 });
    expect(weights.get('happy')).toBe(0.6);
    for (const other of ['neutral', 'angry', 'sad', 'relaxed', 'surprised']) {
      expect(weights.get(other)).toBe(0);
    }
  });

  it('releases an expression when a later call leaves it out', () => {
    expect(weightsFor(plan, {}).get('happy')).toBe(0);
  });

  it('takes the larger of two names on one target rather than the sum', () => {
    expect(weightsFor(plan, { happy: 0.3, mouthSmile: 1 }).get('happy')).toBe(0.5);
    expect(weightsFor(plan, { happy: 0.8, mouthSmile: 1 }).get('happy')).toBe(0.8);
  });

  it('clamps out-of-range and non-finite weights', () => {
    expect(weightsFor(plan, { happy: 3 }).get('happy')).toBe(1);
    expect(weightsFor(plan, { sad: -1 }).get('sad')).toBe(0);
    expect(weightsFor(plan, { angry: Number.NaN }).get('angry')).toBe(0);
  });
});
