import { describe, expect, it } from 'vitest';
import { computePixelRatio } from './pixel-ratio';

describe('computePixelRatio', () => {
  it('passes an ordinary display straight through', () => {
    expect(computePixelRatio(1920, 1)).toBe(1);
  });

  it('caps a high-dpr display at 2', () => {
    expect(computePixelRatio(1920, 3)).toBe(2);
  });

  it('never asks for a buffer wider than 3840', () => {
    expect(computePixelRatio(3840, 2)).toBe(1);
  });

  it('scales down to fit 3840 rather than snapping to a cap that still overshoots', () => {
    expect(computePixelRatio(2560, 2)).toBe(1.5);
  });
});
