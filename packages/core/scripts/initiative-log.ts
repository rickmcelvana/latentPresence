import { writeFileSync } from 'node:fs';
import { INITIATIVE_BUDGETS, simulateInitiativeDay } from '../src/initiative';

/**
 * `pnpm initiative:log` (P6-T03, ADR-52): the done-when's simulated day, written down — one day at
 * each setting in full (seed 1), and thirty days at each held to every rule. Deterministic, so
 * the file only changes when the rules or the simulation do.
 */

const SEEDS = Array.from({ length: 30 }, (_, index) => index + 1);
const time = (at: number): string => new Date(at).toTimeString().slice(0, 5);

const out: string[] = [
  '# P6-T03 — a day with her page open, simulated',
  '',
  'Written by `pnpm initiative:log` from `simulateInitiativeDay`, which drives the real',
  '`attachInitiative` on a real conversation machine with a simulated clock (ADR-52). The person is',
  'up from about half past seven to eleven and leaves the tab open overnight; reloads the page two',
  'to four times a day (the budget is kept in a system block, so a reload must not refill it);',
  'talks in bursts, typed (with time spent typing) or by voice (the panel open); and answers her',
  'about half the time. Two follow-ups come due for the day, a third at a set hour that may be at',
  'night. Every turn she starts is checked as it happens against the person — speaking, typing, a',
  'call open, she busy, her last one unanswered — and the run against the budget over every',
  'rolling 24 hours, the gap between check-ins, and no thoughts at rare or at night.',
  '',
  '| Setting | Budget a day | Gap | Days | Turns she started (min–max a day) | Openers / follow-ups / thoughts | Rules broken |',
  '|---|---|---|---|---|---|---|',
];

const details: string[] = [];
for (const dial of ['off', 'rare', 'normal'] as const) {
  const days = SEEDS.map((seed) => simulateInitiativeDay({ seed, dial }));
  const counts = days.map((day) => day.spoke.length);
  const kinds = (kind: string): number => days.reduce((total, day) => total + day.spoke.filter((entry) => entry.kind === kind).length, 0);
  const broken = days.reduce((total, day) => total + day.violations.length, 0);
  const budget = dial === 'off' ? null : INITIATIVE_BUDGETS[dial];
  out.push(
    `| ${dial} | ${budget === null ? 0 : budget.perDay} | ${budget === null ? '—' : `${budget.gapMs / 60_000} min`} | ${days.length} | ${Math.min(...counts)}–${Math.max(...counts)} | ${kinds('opener')} / ${kinds('follow-up')} / ${kinds('thought')} | **${broken}** |`,
  );
  const first = days[0];
  if (first === undefined) continue;
  details.push(
    `## ${dial}, seed 1 — ${first.visits} visits, ${first.userTurns} turns of theirs`,
    '',
    ...(first.spoke.length === 0
      ? ['She started nothing.', '']
      : ['| Time | She | About | Answered |', '|---|---|---|---|', ...first.spoke.map((entry) => `| ${time(entry.at)} | ${entry.kind} | ${entry.key ?? '—'} | ${entry.answered ? 'yes' : 'no'} |`), '']),
  );
}

out.push('', 'Three-day runs (ten seeds, rare and normal) are held to the same rules in `initiative.test.ts`.', '', ...details);
writeFileSync(new URL('../../../docs/runs/P6-T03-initiative-day.md', import.meta.url), `${out.join('\n')}\n`);
console.log('wrote docs/runs/P6-T03-initiative-day.md');
