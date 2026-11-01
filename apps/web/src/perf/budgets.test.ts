import { describe, expect, it } from 'vitest';
import { BUNDLE_BUDGETS, PIPELINE_BUDGET, STAGE_BUDGET } from './budgets';

/**
 * The budgets are CI's numbers; PLAN.md's are a person's (P9-T02, ADR-68). Raising a CI
 * number is a decision; raising it past the plan's is a different one, and needs an ADR.
 */
describe('the budgets stay inside PLAN.md', () => {
  it('leave the heap and the stage textures well under 400 MB of browser memory without models', () => {
    expect(STAGE_BUDGET.heapBytes + STAGE_BUDGET.textureBytes).toBeLessThan(400_000_000 / 4);
  });

  it('leave most of the 500 ms pipeline budget to the models', () => {
    expect(PIPELINE_BUDGET.ownShareMs).toBeLessThanOrEqual(500 / 10);
  });

  it('budget every page the app routes to, and /chat with the stage it suspends on', () => {
    expect(Object.keys(BUNDLE_BUDGETS.routes).toSorted()).toEqual(['boot', 'chat', 'settings', 'welcome']);
    expect(BUNDLE_BUDGETS.routes['chat']?.chunks).toEqual(['ChatPage', 'CallStage']);
  });
});
