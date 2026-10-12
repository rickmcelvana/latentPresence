import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../gaze';
import { IDLE_INTERRUPT_MS, IDLE_TURN_EASE_IN_MS, IdlePerformer, MAX_TURN, STAGE_PROPS, posePerform, propAngles, type IdleFrame, type IdleMove } from './performer';

const HEAD: Vec3 = [0, 1.5, 0];

function run(performer: IdlePerformer, ms: number, step = 16): IdleFrame[] {
  const frames: IdleFrame[] = [];
  for (let t = 0; t < ms; t += step) frames.push(performer.update(step, HEAD));
  return frames;
}

const yawOf = (frame: IdleFrame): number =>
  (['spine', 'chest', 'upperChest', 'neck', 'head'] as const).reduce((sum, bone) => sum + (frame.additive[bone]?.[1] ?? 0), 0);

describe('IdlePerformer (P6-T01, ADR-50)', () => {
  it('finds each prop behind her: the window over her left shoulder, the whiteboard over her right', () => {
    const window = propAngles(STAGE_PROPS.window, HEAD);
    const whiteboard = propAngles(STAGE_PROPS.whiteboard, HEAD);
    expect(window.yaw).toBeGreaterThan(Math.PI / 2);
    expect(window.pitch).toBeGreaterThan(0);
    expect(whiteboard.yaw).toBeLessThan(-Math.PI / 2);
    expect(propAngles(STAGE_PROPS.desk, HEAD).pitch).toBeLessThan(0);
  });

  it('turns towards a prop over the shoulder, never more than MAX_TURN, and finds it with the eyes', () => {
    const performer = new IdlePerformer();
    performer.start({ gaze: 'window', pose: 'turn', durationMs: 8000 });
    const frames = run(performer, 4000);
    const held = frames[frames.length - 1]!;
    expect(yawOf(held)).toBeCloseTo(MAX_TURN, 3);
    expect(held.lookAt).toEqual(STAGE_PROPS.window);
    expect(held.gazeBase).toBeNull();
    expect(held.additive.hips).toBeUndefined();
    // Eased in: the first frames are a small part of the turn.
    expect(Math.abs(yawOf(frames[2]!))).toBeLessThan(MAX_TURN * 0.05);
  });

  it('turns the other way for the whiteboard', () => {
    const performer = new IdlePerformer();
    performer.start({ gaze: 'whiteboard', pose: 'turn', durationMs: 8000 });
    expect(yawOf(run(performer, 3000).at(-1)!)).toBeLessThan(-MAX_TURN * 0.99);
  });

  it('hands the start of a gesture and an emote to the cue performer, once', () => {
    const performer = new IdlePerformer();
    performer.start({ gaze: 'away', gesture: 'think', emote: 'curiosity', durationMs: 5000 });
    const frames = run(performer, 200);
    expect(frames[0]!.cues).toEqual({ gesture: 'think', emote: 'curiosity' });
    expect(frames.slice(1).every((frame) => frame.cues === null)).toBe(true);
  });

  it('steers the life layer for an ordinary gaze target while it is well under way', () => {
    const performer = new IdlePerformer();
    performer.start({ gaze: 'down', durationMs: 6000 });
    const frames = run(performer, 3000);
    expect(frames[0]!.gazeBase).toBeNull();
    expect(frames.at(-1)!.gazeBase).toBe('down');
  });

  it('eases out and ends on its own, then is quiet', () => {
    const performer = new IdlePerformer();
    performer.start({ pose: 'sway', durationMs: 3000 });
    const frames = run(performer, 3100);
    const last = frames.findIndex((frame) => frame.ended);
    expect(last).toBeGreaterThan(0);
    expect(performer.active).toBe(false);
    expect(Math.abs(frames[last - 1]!.additive.hips?.[2] ?? 0)).toBeLessThan(0.005);
    expect(performer.update(16, HEAD)).toEqual(expect.objectContaining({ additive: {}, ended: false }));
  });

  it('lets go within IDLE_INTERRUPT_MS when someone speaks, from wherever she was', () => {
    const performer = new IdlePerformer();
    performer.start({ gaze: 'window', pose: 'turn', durationMs: 20_000 });
    run(performer, IDLE_TURN_EASE_IN_MS + 500);
    performer.interrupt();
    const frames = run(performer, IDLE_INTERRUPT_MS + 32);
    const ended = frames.findIndex((frame) => frame.ended);
    expect(ended).toBeGreaterThan(0);
    expect(ended * 16).toBeLessThanOrEqual(IDLE_INTERRUPT_MS + 16);
    expect(Math.abs(yawOf(frames[ended]!))).toBeLessThan(0.01);
    expect(performer.active).toBe(false);
  });

  it('closes her eyes and opens her mouth in a yawn, and lets her head drop in a doze', () => {
    const yawn = posePerform('yawn', 2000, 4000, { yaw: 0, pitch: 0 });
    expect(yawn.mouthOpen).toBeGreaterThan(0.8);
    expect(yawn.eyesClosed).toBeGreaterThan(0.8);
    expect(yawn.rotations.head?.[0]).toBeLessThan(0); // the head goes back
    const doze = posePerform('doze', 15_000, 30_000, { yaw: 0, pitch: 0 });
    expect(doze.rotations.head?.[0]).toBeGreaterThan(0.25); // forward
    expect(doze.eyesClosed).toBe(1);
  });

  it('raises both arms in a stretch, the left with +Z and the right with −Z', () => {
    const stretch = posePerform('stretch', 2200, 5000, { yaw: 0, pitch: 0 });
    expect(stretch.rotations.leftUpperArm?.[2]).toBeGreaterThan(1.5);
    expect(stretch.rotations.rightUpperArm?.[2]).toBeLessThan(-1.5);
  });

  it('replaces one activity with the next at once', () => {
    const performer = new IdlePerformer();
    const first: IdleMove = { gaze: 'window', pose: 'turn', durationMs: 10_000 };
    performer.start(first);
    run(performer, 2000);
    performer.start({ gaze: 'down', durationMs: 4000 });
    expect(performer.update(16, HEAD).cues).toEqual({ gesture: null, emote: null });
  });
});
