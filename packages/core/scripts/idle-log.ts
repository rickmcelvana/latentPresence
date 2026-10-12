import { writeFileSync } from 'node:fs';
import { IDLE_COOLDOWN_MS, IDLE_SCENARIOS, simulateIdle } from '../src/idle';

/**
 * `pnpm idle:log` (P6-T01): four simulated idle hours, written as P6-T01's done-when asks — a log
 * to read for variety and plausibility. Deterministic (seed 1), so the file only changes when the
 * planner or the catalogue does.
 */

const clock = (start: Date, atMs: number): string => {
  const at = new Date(start.getTime() + atMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`;
};

const out: string[] = [
  '# P6-T01 — four idle hours, simulated',
  '',
  'Written by `pnpm idle:log` from `simulateIdle` (seed 1). Idle begins after 20 s of quiet; she',
  'rests between activities, and stillness competes in every draw (ADR-50). The test runs the same',
  `four hours with 20 seeds each and holds every one to: no activity again within ${IDLE_COOLDOWN_MS / 60_000} minutes, at`,
  'least eight different things, none more than a fifth of them or five times, and the plausibility',
  'rules (no doze before 15 minutes or in the morning, no yawn with energy over 0.45, no reading a',
  'blank board, no humming when low).',
  '',
];

for (const scenario of IDLE_SCENARIOS) {
  const log = simulateIdle({ ...scenario, seed: 1 });
  const distinct = new Set(log.map((entry) => entry.id)).size;
  const busy = log.reduce((total, entry) => total + entry.durationMs, 0) / (scenario.minutes * 60_000);
  out.push(
    `## ${scenario.name} — from ${clock(scenario.start, 0)}, pleasure ${scenario.pleasure}`,
    '',
    `${log.length} things, ${distinct} different, busy ${Math.round(busy * 100)}% of the hour; the rest is breathing, blinking and the gaze drifting.`,
    '',
    '| time | quiet for | energy | she | for |',
    '|---|---|---|---|---|',
    ...log.map((entry) => `| ${clock(scenario.start, entry.atMs)} | ${Math.floor(entry.atMs / 60_000)} min | ${entry.energy.toFixed(2)} | ${entry.label} | ${Math.round(entry.durationMs / 1000)} s |`),
    '',
  );
}

const path = new URL('../../../docs/runs/P6-T01-idle-hours.md', import.meta.url);
writeFileSync(path, out.join('\n'));
console.log(`wrote ${path.pathname}`);
