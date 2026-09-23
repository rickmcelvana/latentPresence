import { describe, expect, it } from 'vitest';
import type { ConversationState } from '@latentpresence/protocol';
import { BlinkScheduler, blinkWeight } from './blink';
import { Breathing, breathLevel } from './breathing';
import { GazePolicy } from './gaze-policy';
import { LIFE_BONES, LifeLayer, type LifePose } from './life';
import { DEFAULT_LIFE_PARAMS, type MoodParams } from './params';
import { createRandom } from './random';
import { WeightShift } from './weight-shift';

const FRAME = 1000 / 60;
const P = DEFAULT_LIFE_PARAMS;

/** Steps `fn` at 60 fps for `ms` of simulated time. */
function run<T>(ms: number, fn: (elapsed: number) => T): T[] {
  const out: T[] = [];
  for (let t = 0; t < ms; t += FRAME) out.push(fn(t));
  return out;
}

/** Rising edges of a weight crossing 0.5: how many blinks happened. */
function countBlinks(weights: readonly number[]): number {
  let count = 0;
  for (let i = 1; i < weights.length; i += 1) {
    if ((weights[i - 1] ?? 0) < 0.5 && (weights[i] ?? 0) >= 0.5) count += 1;
  }
  return count;
}

describe('createRandom', () => {
  it('is the same sequence for the same seed, and a different one for another', () => {
    const a = createRandom(7);
    const b = createRandom(7);
    const c = createRandom(8);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('breathing', () => {
  it('is continuous around the whole cycle, including the wrap', () => {
    for (let phase = 0; phase < 1; phase += 0.001) {
      expect(Math.abs(breathLevel(phase + 0.001, 0.4) - breathLevel(phase, 0.4))).toBeLessThan(0.01);
    }
    expect(breathLevel(0, 0.4)).toBeCloseTo(0);
    expect(breathLevel(0.4, 0.4)).toBeCloseTo(1);
  });

  it('breathes at the rate asked for', () => {
    const breath = new Breathing(0.4);
    const levels = run(60_000, () => breath.update(FRAME, 15));
    expect(countBlinks(levels)).toBe(15);
  });

  it('inhales faster than it exhales', () => {
    const levels = run(4000, (t) => breathLevel(t / 4000, 0.4));
    const peak = levels.indexOf(Math.max(...levels));
    expect(peak).toBeLessThan(levels.length / 2);
  });

  it('changes rate without jumping', () => {
    const breath = new Breathing(0.4, 0.2);
    breath.update(FRAME, 12);
    // Only the phase's speed changes: the next level carries on from where the last was.
    const after = breath.update(FRAME, 20);
    expect(after).toBeCloseTo(breathLevel(0.2 + (FRAME * 12) / 60_000 + (FRAME * 20) / 60_000, 0.4), 10);
  });
});

describe('blinking', () => {
  it('has the shape of a blink: shut fast, a moment closed, open slower', () => {
    const { closeMs, holdMs, openMs } = P.blink;
    expect(blinkWeight(0, closeMs, holdMs, openMs)).toBe(0);
    expect(blinkWeight(closeMs + holdMs / 2, closeMs, holdMs, openMs)).toBe(1);
    expect(blinkWeight(closeMs + holdMs + openMs, closeMs, holdMs, openMs)).toBe(0);
    expect(openMs).toBeGreaterThan(closeMs);
  });

  it('blinks at about the mean rate it is given', () => {
    const blink = new BlinkScheduler(P.blink, createRandom(3), 3000);
    const weights = run(120_000, () => blink.update(FRAME, 3000));
    // 40 at the mean; the spread and the occasional double blink put it near there.
    const count = countBlinks(weights);
    expect(count).toBeGreaterThan(32);
    expect(count).toBeLessThan(50);
  });

  it('follows a slower rate when the state asks for one', () => {
    const fast = new BlinkScheduler(P.blink, createRandom(5), 2500);
    const slow = new BlinkScheduler(P.blink, createRandom(5), 5000);
    const nFast = countBlinks(run(120_000, () => fast.update(FRAME, 2500)));
    const nSlow = countBlinks(run(120_000, () => slow.update(FRAME, 5000)));
    expect(nFast).toBeGreaterThan(nSlow * 1.5);
  });

  it('never stays shut: every blink opens again within its own length', () => {
    const blink = new BlinkScheduler(P.blink, createRandom(9), 2000);
    const weights = run(60_000, () => blink.update(FRAME, 2000));
    let shut = 0;
    let longest = 0;
    for (const w of weights) {
      shut = w > 0 ? shut + FRAME : 0;
      longest = Math.max(longest, shut);
    }
    expect(longest).toBeLessThanOrEqual(P.blink.closeMs + P.blink.holdMs + P.blink.openMs + FRAME);
  });

  it('blinks with a saccade when allowed, and not inside the refractory period', () => {
    const always = { ...P.blink, withSaccadeChance: 1, doubleChance: 0 };
    const blink = new BlinkScheduler(always, createRandom(1), 60_000);
    blink.update(1000, 60_000);
    blink.withSaccade();
    expect(blink.update(FRAME * 3, 60_000)).toBeGreaterThan(0);
    run(400, () => blink.update(FRAME, 60_000));
    blink.withSaccade(); // ~150 ms after it ended: refused
    expect(blink.update(FRAME * 3, 60_000)).toBe(0);
  });
});

describe('gaze policy', () => {
  function shareOnUser(mood: MoodParams, seed: number): number {
    const policy = new GazePolicy(P.gaze, createRandom(seed), mood);
    const targets = run(300_000, () => policy.update(FRAME, mood).target);
    return targets.filter((t) => t === 'user').length / targets.length;
  }

  it('keeps a listener on the user most of the time, and a speaker less', () => {
    const listening = shareOnUser(P.moods.listening, 11);
    const speaking = shareOnUser(P.moods.speaking, 11);
    const thinking = shareOnUser(P.moods.thinking, 11);
    expect(listening).toBeGreaterThan(0.75);
    expect(speaking).toBeLessThan(listening);
    expect(thinking).toBeLessThan(speaking);
  });

  it('always comes back: no look away outlasts a few times its mean', () => {
    const mood = P.moods.thinking;
    const policy = new GazePolicy(P.gaze, createRandom(4), mood);
    let away = 0;
    let longest = 0;
    for (const choice of run(300_000, () => policy.update(FRAME, mood))) {
      away = choice.target === 'user' ? 0 : away + FRAME;
      longest = Math.max(longest, away);
    }
    expect(longest).toBeGreaterThan(0);
    expect(longest).toBeLessThan(mood.awayMeanMs * 2 + FRAME);
  });

  it('only looks where the mood allows', () => {
    const mood = P.moods.thinking;
    const policy = new GazePolicy(P.gaze, createRandom(6), mood);
    const seen = new Set(run(120_000, () => policy.update(FRAME, mood).target));
    for (const target of seen) expect(['user', ...mood.awayTargets]).toContain(target);
  });

  it('hops between points on the face while on the user, within the radius', () => {
    const mood = { ...P.moods.listening, lookAwayChance: 0 };
    const policy = new GazePolicy(P.gaze, createRandom(2), mood);
    const offsets = run(20_000, () => policy.update(FRAME, mood).offset);
    const distinct = new Set(offsets.map((o) => o.join(',')));
    expect(distinct.size).toBeGreaterThan(10);
    for (const [x, y] of offsets) expect(Math.hypot(x, y)).toBeLessThanOrEqual(P.gaze.fixationRadius + 1e-9);
  });

  it('flags a shift on the frame the target changes, and only then', () => {
    const mood = P.moods.thinking;
    const policy = new GazePolicy(P.gaze, createRandom(8), mood);
    let previous = 'user';
    for (const choice of run(60_000, () => policy.update(FRAME, mood))) {
      expect(choice.shifted).toBe(choice.target !== previous);
      previous = choice.target;
    }
  });

  it('moves to a new base at once', () => {
    const mood = { ...P.moods.listening, lookAwayChance: 0 };
    const policy = new GazePolicy(P.gaze, createRandom(2), mood);
    expect(policy.setBase('screen')).toBe(true);
    expect(policy.update(FRAME, mood).target).toBe('screen');
  });
});

describe('weight shift', () => {
  it('stays within its travel and never jumps', () => {
    const shift = new WeightShift(P.weightShift, createRandom(12));
    const stances = run(120_000, () => shift.update(FRAME));
    for (const s of stances) expect(Math.abs(s.hipShift)).toBeLessThanOrEqual(P.weightShift.hipTravel + 1e-9);
    for (let i = 1; i < stances.length; i += 1) {
      expect(Math.abs((stances[i]?.hipShift ?? 0) - (stances[i - 1]?.hipShift ?? 0))).toBeLessThan(0.001);
    }
  });

  it('shifts to the other side, several times a couple of minutes', () => {
    const shift = new WeightShift(P.weightShift, createRandom(12));
    const sides = run(120_000, () => Math.sign(shift.update(FRAME).hipShift));
    let changes = 0;
    for (let i = 1; i < sides.length; i += 1) if (sides[i] !== sides[i - 1] && sides[i] !== 0) changes += 1;
    expect(changes).toBeGreaterThanOrEqual(4);
  });
});

describe('LifeLayer', () => {
  function minute(seed: number, state: ConversationState = 'listening'): LifePose[] {
    const life = new LifeLayer(P, seed);
    life.setState(state);
    return run(60_000, () => life.update(FRAME));
  }

  it('is the same minute for the same seed', () => {
    expect(minute(21).slice(-5)).toEqual(minute(21).slice(-5));
  });

  it('is not frozen: breathing, blinking, gaze and stance all move in a minute', () => {
    const poses = minute(22);
    const chest = new Set(poses.map((p) => p.additive.chest?.[0].toFixed(4)));
    expect(chest.size).toBeGreaterThan(50);
    expect(countBlinks(poses.map((p) => p.blink))).toBeGreaterThan(8);
    expect(new Set(poses.map((p) => p.gaze.offset.join(','))).size).toBeGreaterThan(20);
    expect(new Set(poses.map((p) => p.hipsOffset[0].toFixed(5))).size).toBeGreaterThan(50);
  });

  it('never pops: no bone turns more than a little between frames', () => {
    const poses = minute(23, 'thinking');
    for (let i = 1; i < poses.length; i += 1) {
      for (const bone of LIFE_BONES) {
        const a = poses[i - 1]?.additive[bone];
        const b = poses[i]?.additive[bone];
        if (a === undefined || b === undefined) continue;
        // 0.02 rad a frame is ~70°/s: a head turn, not a jump.
        for (let axis = 0; axis < 3; axis += 1) expect(Math.abs((a[axis] ?? 0) - (b[axis] ?? 0))).toBeLessThan(0.02);
      }
    }
  });

  it('keeps every motion small — life, not gesture', () => {
    for (const pose of minute(24, 'thinking')) {
      for (const rotation of Object.values(pose.additive)) {
        for (const angle of rotation) expect(Math.abs(angle)).toBeLessThan(0.25);
      }
    }
  });

  it('turns the head the same way the eyes go', () => {
    const life = new LifeLayer({ ...P, moods: { ...P.moods, idle: { ...P.moods.idle, lookAwayChance: 0 } } }, 5);
    life.setGazeBase('away');
    let pose = life.update(FRAME);
    for (let i = 0; i < 120; i += 1) pose = life.update(FRAME);
    // 'away' is towards the character's left (+Y) and a little up (-X).
    expect(pose.additive.head?.[1]).toBeGreaterThan(0.05);
    expect(pose.additive.head?.[0]).toBeLessThan(0);
  });

  it('carries on after a tab returns from the background, rather than replaying it', () => {
    const life = new LifeLayer(P, 30);
    const before = life.update(FRAME);
    const after = life.update(60_000);
    // One capped step: the breath has moved a little, not a minute's worth of cycles.
    expect(Math.abs((after.additive.chest?.[0] ?? 0) - (before.additive.chest?.[0] ?? 0))).toBeLessThan(0.005);
    expect(Math.abs(after.hipsOffset[0] - before.hipsOffset[0])).toBeLessThan(0.002);
  });

  it('puts the arms down in the rest pose, left with -Z and right with +Z', () => {
    const pose = new LifeLayer().update(FRAME);
    expect(pose.rest.leftUpperArm?.[2]).toBeLessThan(0);
    expect(pose.rest.rightUpperArm?.[2]).toBeGreaterThan(0);
  });

  // P3-T02: a modulation of null must be a true no-op, so `/chat` (which never calls
  // `setModulation`) sees exactly the frames it always has.
  it('setModulation(null) leaves a seeded run identical', () => {
    const life = new LifeLayer(P, 25);
    life.setState('listening');
    life.setModulation(null);
    expect(run(60_000, () => life.update(FRAME))).toEqual(minute(25));
  });

  it('keeps the eyes on the base target over a minute when lookAwayScale is 0', () => {
    const life = new LifeLayer(P, 26);
    life.setState('thinking'); // normally looks away a lot
    life.setModulation({ lookAwayScale: 0, holdScale: 1, awayMeanScale: 1, blinkScale: 1, breathScale: 1 });
    const poses = run(60_000, () => life.update(FRAME));
    expect(poses.every((pose) => pose.gaze.target === 'user')).toBe(true);
  });
});
