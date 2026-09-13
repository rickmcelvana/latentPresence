import { describe, expect, it } from 'vitest';
import { BargeInGate } from './barge-in';

const FRAME = 32;

function run(gate: BargeInGate, probabilities: readonly number[]): (string | null)[] {
  return probabilities.map((p) => gate.push(p, FRAME));
}

describe('BargeInGate', () => {
  it('does nothing until armed, whatever the user says', () => {
    const gate = new BargeInGate();
    expect(run(gate, [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])).toEqual(Array(8).fill(null));
  });

  it('ducks on the first speech frame and commits once bargeInMs of speech is heard', () => {
    const gate = new BargeInGate({ bargeInMs: 200 });
    gate.arm();
    // 32 ms frames: 7 of them is 224 ms, the first to reach 200.
    expect(run(gate, [0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])).toEqual([
      null, 'duck', null, null, null, null, null, 'commit',
    ]);
  });

  it('commits exactly at the boundary, not a frame later', () => {
    const gate = new BargeInGate({ bargeInMs: 192 });
    gate.arm();
    expect(run(gate, [0.9, 0.9, 0.9, 0.9, 0.9, 0.9])).toEqual([
      'duck', null, null, null, null, 'commit',
    ]);
  });

  it('lets a short noise go: unducks after releaseMs of silence and never commits', () => {
    const gate = new BargeInGate({ bargeInMs: 200, releaseMs: 100 });
    gate.arm();
    // A 64 ms cough, then 128 ms of quiet: the release fires on the fourth quiet frame.
    expect(run(gate, [0.9, 0.9, 0.1, 0.1, 0.1, 0.1])).toEqual([
      'duck', null, null, null, null, 'unduck',
    ]);
    expect(gate.ducked).toBe(false);
  });

  it('holds between speechOff and speechOn instead of chattering', () => {
    const gate = new BargeInGate({ bargeInMs: 200 });
    gate.arm();
    // 0.4 is under speechOn but over speechOff: it keeps a duck alive and counts as speech.
    expect(run(gate, [0.9, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4])).toEqual([
      'duck', null, null, null, null, null, 'commit',
    ]);
  });

  it('does not start a duck on a frame between the thresholds', () => {
    const gate = new BargeInGate();
    gate.arm();
    expect(run(gate, [0.4, 0.4, 0.4])).toEqual([null, null, null]);
  });

  it('resets the silence count when speech comes back inside the release window', () => {
    const gate = new BargeInGate({ bargeInMs: 200, releaseMs: 100 });
    gate.arm();
    // Speech, a 64 ms gap, speech: the gap is not long enough to release, and the voiced
    // time keeps adding up across it (32 × 7 = 224).
    expect(run(gate, [0.9, 0.9, 0.9, 0.1, 0.1, 0.9, 0.9, 0.9, 0.9])).toEqual([
      'duck', null, null, null, null, null, null, null, 'commit',
    ]);
  });

  it('with bargeInMs 0 commits on the first speech frame, the plan rule', () => {
    const gate = new BargeInGate({ bargeInMs: 0 });
    gate.arm();
    expect(run(gate, [0.1, 0.9])).toEqual([null, 'commit']);
  });

  it('commits once and stays quiet afterwards until re-armed', () => {
    const gate = new BargeInGate({ bargeInMs: 0 });
    gate.arm();
    expect(run(gate, [0.9, 0.9])).toEqual(['commit', null]);
    gate.arm();
    expect(gate.push(0.9, FRAME)).toBeNull();
    gate.disarm();
    gate.arm();
    expect(gate.push(0.9, FRAME)).toBe('commit');
  });

  it('asks for an unduck when disarmed while ducked, and not otherwise', () => {
    const gate = new BargeInGate();
    gate.arm();
    expect(gate.disarm()).toBeNull();
    gate.arm();
    gate.push(0.9, FRAME);
    expect(gate.disarm()).toBe('unduck');
    expect(gate.push(0.9, FRAME)).toBeNull();
  });

  it('refuses a configuration it cannot honour', () => {
    expect(() => new BargeInGate({ bargeInMs: -1 })).toThrow(RangeError);
    expect(() => new BargeInGate({ releaseMs: 0 })).toThrow(RangeError);
    expect(() => new BargeInGate({ speechOn: 0.3, speechOff: 0.5 })).toThrow(RangeError);
  });
});
