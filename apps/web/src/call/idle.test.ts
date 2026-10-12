import { describe, expect, it } from 'vitest';
import { IDLE_ACTIVITIES, IdlePlanner } from '@latentpresence/core';
import type { Vec3 } from '@latentpresence/avatar';
import { IDLE_QUIET_MS, IdleDirector, type IdleSituation } from './idle';

const HEAD: Vec3 = [0, 1.5, 0];
const SITUATION: IdleSituation = { state: 'idle', pleasure: 0.3, energy: 0.6, showing: { whiteboard: false, screen: false }, now: new Date(2026, 9, 12, 15) };

/** A planner with one activity and no stillness in the draw, so the test knows what comes. */
function director(): IdleDirector {
  const window = IDLE_ACTIVITIES.filter((activity) => activity.id === 'window');
  return new IdleDirector({ planner: new IdlePlanner({ random: () => 0, restScore: 0, catalogue: window }) });
}

function step(subject: IdleDirector, ms: number, situation: IdleSituation = SITUATION) {
  let frame = subject.update(16, situation, HEAD);
  for (let t = 16; t < ms; t += 16) frame = subject.update(16, situation, HEAD);
  return frame;
}

describe('IdleDirector (P6-T01, ADR-50)', () => {
  it('does nothing of her own until it has been quiet for IDLE_QUIET_MS', () => {
    const subject = director();
    expect(step(subject, IDLE_QUIET_MS - 100).doing).toBeNull();
    // Window needs 30 s of quiet (its `afterMs`): asked at 20 s it does not fit, and she rests.
    expect(step(subject, 1000).doing).toBeNull();
  });

  it('starts an activity once it fits, and says what she is doing', () => {
    const subject = director();
    let seen: string | null = null;
    let seconds = 0;
    while (seen === null && seconds < 300) {
      seen = step(subject, 1000).doing;
      seconds += 1;
    }
    expect(seen).toBe('looks out of the window');
    // Not before the window's own 30 s of quiet.
    expect(seconds).toBeGreaterThanOrEqual(30);
  });

  it('stops at once when something happens, and waits the quiet out again', () => {
    const subject = director();
    let frame = step(subject, 1000);
    for (let i = 0; i < 400 && frame.doing === null; i += 1) frame = step(subject, 1000);
    expect(frame.doing).not.toBeNull();
    subject.activity();
    frame = step(subject, 400);
    expect(frame.doing).toBeNull();
    expect(Object.values(frame.additive).every((rotation) => rotation.every((value) => Math.abs(value) < 1e-6))).toBe(true);
    expect(step(subject, IDLE_QUIET_MS - 1000).doing).toBeNull();
  });

  it('is never idle while she is listening, thinking or speaking', () => {
    const subject = director();
    expect(step(subject, 5 * 60_000, { ...SITUATION, state: 'speaking' }).doing).toBeNull();
    expect(step(subject, 5 * 60_000, { ...SITUATION, state: 'listening' }).doing).toBeNull();
  });
});
