import { describe, expect, it } from 'vitest';
import { IDLE_ACTIVITIES, dayPart } from './catalogue';
import { IDLE_COOLDOWN_MS, IdlePlanner, seededRandom, type IdleContext } from './planner';
import { IDLE_SCENARIOS, simulateIdle, type IdleLogEntry, type IdleScenario } from './simulate';

const at = (hour: number, minute = 0): Date => new Date(2026, 9, 12, hour, minute);

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

function hours(): { scenario: Omit<IdleScenario, 'seed'>; log: IdleLogEntry[] }[] {
  return IDLE_SCENARIOS.flatMap((scenario) => SEEDS.map((seed) => ({ scenario, log: simulateIdle({ ...scenario, seed }) })));
}

const context = (over: Partial<IdleContext> = {}): IdleContext => ({
  now: at(15),
  quietMs: 30 * 60_000,
  pleasure: 0.3,
  energy: 0.6,
  showing: { whiteboard: true, screen: true },
  ...over,
});

describe('an idle hour (P6-T01 done-when, ADR-50)', () => {
  it('never repeats an activity within 10 minutes, in any of 80 simulated hours', () => {
    for (const { scenario, log } of hours()) {
      const last = new Map<string, number>();
      for (const entry of log) {
        const before = last.get(entry.id);
        if (before !== undefined) expect(entry.atMs - before, `${scenario.name}: ${entry.id}`).toBeGreaterThanOrEqual(IDLE_COOLDOWN_MS);
        last.set(entry.id, entry.atMs);
      }
    }
  });

  it('is varied: at least eight different things an hour, none more than a fifth of them or five times', () => {
    for (const { scenario, log } of hours()) {
      const counts = new Map<string, number>();
      for (const entry of log) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
      expect(counts.size, scenario.name).toBeGreaterThanOrEqual(8);
      for (const [id, count] of counts) {
        expect(count / log.length, `${scenario.name}: ${id}`).toBeLessThanOrEqual(1 / 5);
        expect(count, `${scenario.name}: ${id}`).toBeLessThanOrEqual(5);
      }
    }
  });

  it('is plausible: nothing overlaps, and nothing happens where it would not', () => {
    for (const { scenario, log } of hours()) {
      const part = dayPart(scenario.start.getHours());
      log.forEach((entry, index) => {
        const next = log[index + 1];
        if (next !== undefined) expect(entry.atMs + entry.durationMs).toBeLessThanOrEqual(next.atMs);
        const why = `${scenario.name}: ${entry.id} at ${Math.round(entry.atMs / 1000)} s`;
        if (entry.id === 'doze') {
          expect(entry.atMs, why).toBeGreaterThanOrEqual(15 * 60_000);
          expect(entry.energy, why).toBeLessThanOrEqual(0.3);
          expect(part, why).not.toBe('morning');
        }
        if (entry.id === 'yawn') expect(entry.energy, why).toBeLessThanOrEqual(0.45);
        if (entry.id === 'whiteboard') expect(scenario.showing.whiteboard, why).toBe(true);
        if (entry.id === 'screen') expect(scenario.showing.screen, why).toBe(true);
        if (entry.id === 'hum') expect(scenario.pleasure, why).toBeGreaterThanOrEqual(0.25);
        if (entry.id === 'sigh') expect(scenario.pleasure, why).toBeLessThanOrEqual(0.1);
      });
    }
  });

  it('follows her mood: hums on the bright morning, never late and low; dozes only then', () => {
    const ids = (name: string): Set<string> => new Set(hours().filter((hour) => hour.scenario.name === name).flatMap((hour) => hour.log.map((entry) => entry.id)));
    expect(ids('a bright morning').has('hum')).toBe(true);
    expect(ids('a bright morning').has('doze')).toBe(false);
    expect(ids('late, and low').has('hum')).toBe(false);
    expect(ids('late, and low').has('doze')).toBe(true);
    expect(ids('late, and low').has('yawn')).toBe(true);
  });

  it('is the same hour twice with one seed', () => {
    const scenario = { ...IDLE_SCENARIOS[0]!, seed: 7 };
    expect(simulateIdle(scenario)).toEqual(simulateIdle(scenario));
  });
});

describe('IdlePlanner', () => {
  it('scores nothing for an activity done in the last 10 minutes, then lets it back', () => {
    const planner = new IdlePlanner({ random: () => 0, restScore: 0, catalogue: IDLE_ACTIVITIES.filter((activity) => activity.id === 'window') });
    expect(planner.choose(context())?.activity.id).toBe('window');
    expect(planner.choose(context({ now: new Date(at(15).getTime() + IDLE_COOLDOWN_MS - 1) }))).toBeNull();
    expect(planner.choose(context({ now: new Date(at(15).getTime() + IDLE_COOLDOWN_MS) }))?.activity.id).toBe('window');
  });

  it('reads a board only when it shows something', () => {
    const planner = new IdlePlanner({ random: seededRandom(1) });
    const score = (showing: IdleContext['showing'], id: string): number => planner.scores(context({ showing })).find((entry) => entry.activity.id === id)!.score;
    expect(score({ whiteboard: false, screen: false }, 'whiteboard')).toBe(0);
    expect(score({ whiteboard: true, screen: false }, 'whiteboard')).toBeGreaterThan(0);
    expect(score({ whiteboard: false, screen: false }, 'screen')).toBe(0);
  });

  it('waits for the quiet: nothing that needs minutes in the first seconds', () => {
    const planner = new IdlePlanner({ random: seededRandom(1) });
    const early = planner.scores(context({ quietMs: 20_000, energy: 0.5, now: at(23) })).filter((entry) => entry.score > 0).map((entry) => entry.activity.id);
    expect(early).not.toContain('doze');
    expect(early).not.toContain('yawn');
    expect(early).not.toContain('stretch');
    expect(early.length).toBeGreaterThan(0);
  });

  it('halves the odds of two of a kind in a row', () => {
    const planner = new IdlePlanner({ random: () => 0, restScore: 0, catalogue: IDLE_ACTIVITIES.filter((activity) => activity.id === 'window' || activity.id === 'desk') });
    planner.choose(context());
    const desk = planner.scores(context()).find((entry) => entry.activity.id === 'desk')!;
    expect(desk.score).toBeCloseTo(desk.activity.weight * 0.5);
  });

  it('lets stillness win the draw sometimes', () => {
    const only = IDLE_ACTIVITIES.filter((activity) => activity.id === 'window');
    // Window scores 1.2 × 1.2 (afternoon) = 1.44; a draw past it lands on rest.
    expect(new IdlePlanner({ random: () => 0.99, catalogue: only }).choose(context())).toBeNull();
    expect(new IdlePlanner({ random: () => 0.1, catalogue: only }).choose(context())?.activity.id).toBe('window');
  });

  it('rests longer when she is tired', () => {
    const rest = (energy: number): number => new IdlePlanner({ random: () => 0.5 }).restMs(context({ energy }));
    expect(rest(0.1)).toBeGreaterThan(rest(0.9));
  });

  it('names a clip for every activity that moves her body, for the pack that brings them', () => {
    for (const activity of IDLE_ACTIVITIES) if (activity.perform.pose !== undefined) expect(activity.perform.clip, activity.id).toBeTruthy();
  });
});
