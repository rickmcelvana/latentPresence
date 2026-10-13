import { writeFileSync } from 'node:fs';
import { FIRING_CASES, GENERATED_FIRING_CASES, PLAN_CASES, firingsOf, planOf } from '../src/scheduler/fixtures/cases';

/**
 * `pnpm schedule:fixtures` (P6-T07b, ADR-57): writes what the core's scheduler (croner 10.0.1)
 * answers for each case in `fixtures/cases.ts` to `fixtures/firings.json`. The core's test holds
 * itself to the file, and the companion's Rust scheduler reads the same file — two cron
 * implementations, one answer. Regenerate only on purpose: a change here is a change in when
 * people's schedules fire.
 */
const file = {
  firings: [...FIRING_CASES, ...GENERATED_FIRING_CASES].map((input) => ({ ...input, next: firingsOf(input) })),
  plans: PLAN_CASES.map((input) => ({ ...input, expected: planOf(input) })),
};
writeFileSync(new URL('../src/scheduler/fixtures/firings.json', import.meta.url), `${JSON.stringify(file, null, 2)}\n`);
console.log(`${file.firings.length} firing cases, ${file.plans.length} plan cases`);
