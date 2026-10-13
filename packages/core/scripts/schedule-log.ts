import { writeFileSync } from 'node:fs';
import { simulateScheduleWeek } from '../src/scheduler/simulate';

/**
 * `pnpm schedule:log` (P6-T07, ADR-56): the done-when's simulated week, written down — every
 * page open and close, every run with the firing it was for, every delivery. Deterministic, so
 * the file only changes when the scheduler or the week does.
 */
const week = await simulateScheduleWeek();
const again = await simulateScheduleWeek();
const same = JSON.stringify(week.log) === JSON.stringify(again.log);
const lines = [
  '# P6-T07 — a simulated week of schedules',
  '',
  '`pnpm schedule:log`. Thursday 29 October to Thursday 5 November 2026, America/Toronto (the clocks go',
  'back at 02:00 on Sunday 1 November). The page is open 08:00–23:00, closed at night, away all',
  'Saturday, then left open from Saturday 23:00 to Sunday 23:00. A person comes back when it opens',
  'and every hour while it is open, and is told what is waiting. `src/scheduler/simulate.ts` has the',
  'schedules; `scheduler.test.ts` holds the week to its rules.',
  '',
  `Runs: ${week.runs.length} (${week.runs.filter((run) => run.outcome === 'ok').length} ok, ${week.runs.filter((run) => run.outcome === 'failed').length} failed, ${week.runs.filter((run) => run.outcome === 'skipped').length} skipped). Said: ${week.said.length}. Notified: ${week.notified.length}. Episodes written: ${week.episodes}. Run twice, the log is ${same ? 'identical' : 'DIFFERENT'}.`,
  '',
  '```',
  ...week.log,
  '```',
  '',
];
writeFileSync(new URL('../../../docs/runs/P6-T07-week.md', import.meta.url), lines.join('\n'));
console.log(lines.slice(8, 9).join('\n'));
