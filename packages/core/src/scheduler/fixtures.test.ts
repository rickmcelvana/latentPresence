import { describe, expect, it } from 'vitest';
import { FIRING_CASES, GENERATED_FIRING_CASES, PLAN_CASES, firingsOf, planOf } from './fixtures/cases';
import fixtures from './fixtures/firings.json' with { type: 'json' };

/**
 * The core holds itself to `firings.json` (P6-T07b, ADR-57), which the companion's Rust scheduler
 * reads too: if the core's cron or `planSchedule` ever answers differently, this fails before the two
 * schedulers disagree about when someone's schedule fires.
 */
describe('the shared schedule fixtures', () => {
  it('cover every case, and the core still answers each firing case as recorded', () => {
    const cases = [...FIRING_CASES, ...GENERATED_FIRING_CASES];
    expect(fixtures.firings.map((entry) => entry.name)).toEqual(cases.map((entry) => entry.name));
    for (const [index, input] of cases.entries()) expect(firingsOf(input), input.name).toEqual(fixtures.firings[index]?.next);
  });

  it('and every plan case', () => {
    expect(fixtures.plans.map((entry) => entry.name)).toEqual(PLAN_CASES.map((entry) => entry.name));
    for (const [index, input] of PLAN_CASES.entries()) expect(planOf(input), input.name).toEqual(fixtures.plans[index]?.expected);
  });
});
