import { describe, expect, it } from 'vitest';
import { REST_IN_MS, REST_OUT_MS, REST_POSE, restFrame, restLevel } from './rest';

describe('her rest (P6-T04, ADR-53)', () => {
  it('settles in slowly and comes out quickly', () => {
    expect(restLevel(0, true, REST_IN_MS / 2)).toBeCloseTo(0.5);
    expect(restLevel(0.5, true, REST_IN_MS)).toBe(1);
    expect(restLevel(1, false, REST_OUT_MS)).toBe(0);
    expect(REST_OUT_MS).toBeLessThan(REST_IN_MS / 5);
  });

  it('is nothing at 0, and at 1 the head down with the eyes shut', () => {
    expect(restFrame(0).eyesClosed).toBe(0);
    expect(restFrame(0).additive.head).toEqual([0, 0, 0]);
    const full = restFrame(1);
    expect(full.eyesClosed).toBe(1);
    expect(full.additive.head).toEqual([...REST_POSE.head]);
    expect(full.additive.head?.[0]).toBeGreaterThan(0);
  });
});
