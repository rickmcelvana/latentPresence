import { IdlePlanner, seededRandom, type IdleContext } from './planner';

/**
 * An idle hour, simulated (P6-T01's done-when): the planner asked as the page will ask it — a
 * rest, an activity, a rest — with the quiet growing and her energy where the scenario puts it.
 */

export interface IdleScenario {
  readonly name: string;
  readonly start: Date;
  readonly minutes: number;
  readonly pleasure: number;
  /** Energy at a minute into the hour: a mood that tires as the evening goes on. */
  readonly energyAt: (minute: number) => number;
  readonly showing: IdleContext['showing'];
  readonly seed: number;
}

export interface IdleLogEntry {
  /** Milliseconds since the hour began. */
  readonly atMs: number;
  readonly id: string;
  readonly label: string;
  readonly durationMs: number;
  readonly energy: number;
}

const onDay = (hour: number, minute = 0): Date => new Date(2026, 9, 12, hour, minute);

/** Four hours of her day (a Monday in October): P6-T01's done-when is about any of them. */
export const IDLE_SCENARIOS: readonly Omit<IdleScenario, 'seed'>[] = [
  { name: 'a bright morning', start: onDay(9), minutes: 60, pleasure: 0.45, energyAt: () => 0.75, showing: { whiteboard: true, screen: true } },
  { name: 'a flat afternoon', start: onDay(14, 30), minutes: 60, pleasure: 0, energyAt: () => 0.5, showing: { whiteboard: false, screen: false } },
  { name: 'an evening, tiring', start: onDay(20), minutes: 60, pleasure: 0.15, energyAt: (minute) => 0.6 - (0.4 * minute) / 60, showing: { whiteboard: true, screen: false } },
  { name: 'late, and low', start: onDay(23, 30), minutes: 60, pleasure: -0.35, energyAt: () => 0.2, showing: { whiteboard: false, screen: true } },
];

export function simulateIdle(scenario: IdleScenario): IdleLogEntry[] {
  const planner = new IdlePlanner({ random: seededRandom(scenario.seed) });
  const end = scenario.minutes * 60_000;
  const log: IdleLogEntry[] = [];
  // P6-T01: idle begins after 20 s of quiet (ADR-50).
  let at = 20_000;
  while (at < end) {
    const energy = scenario.energyAt(at / 60_000);
    const context: IdleContext = { now: new Date(scenario.start.getTime() + at), quietMs: at, pleasure: scenario.pleasure, energy, showing: scenario.showing };
    const choice = planner.choose(context);
    if (choice !== null) {
      log.push({ atMs: at, id: choice.activity.id, label: choice.activity.label, durationMs: choice.durationMs, energy });
      at += choice.durationMs;
    }
    at += planner.restMs(context);
  }
  return log;
}
