import { describe, expect, it } from 'vitest';
import { VisemeSchema } from '@latentpresence/protocol';
import {
  OCULUS_VISEMES,
  VISEME_MAP,
  VRM_VISEMES,
  smoothWeight,
  toVrmViseme,
  visemeWeight,
} from './visemes';

/**
 * The mapping is where this goes wrong invisibly.
 *
 * Nothing here throws if the mapping is bad: the avatar renders, the mouth moves, and it
 * looks like chewing. So these tests pin the decisions rather than the mechanics.
 */

describe('VISEME_MAP', () => {
  it('has a VRM shape for every Oculus viseme the analyser can emit', () => {
    // Exhaustive on purpose. A library update that adds a sixteenth viseme should fail
    // here rather than fall through a default to silence, which would read as a mouth
    // that stops moving on certain sounds.
    expect(OCULUS_VISEMES).toHaveLength(15);
    for (const oculus of OCULUS_VISEMES) {
      expect(VisemeSchema.options).toContain(VISEME_MAP[oculus]);
    }
  });

  it('maps the five vowels to their own shape rather than a neighbour', () => {
    expect(toVrmViseme('viseme_aa')).toBe('aa');
    expect(toVrmViseme('viseme_E')).toBe('ee');
    expect(toVrmViseme('viseme_I')).toBe('ih');
    expect(toVrmViseme('viseme_O')).toBe('oh');
    expect(toVrmViseme('viseme_U')).toBe('ou');
  });

  it('closes the mouth for the sounds made with it closed', () => {
    // The bilabial stop and the nasal. Mapping either to a vowel is what makes a "p"
    // look like a shout and an "m" look like a yawn.
    expect(toVrmViseme('viseme_PP')).toBe('sil');
    expect(toVrmViseme('viseme_nn')).toBe('sil');
    expect(toVrmViseme('viseme_sil')).toBe('sil');
  });

  it('rounds the lips for the rounded consonants', () => {
    expect(toVrmViseme('viseme_CH')).toBe('ou');
    expect(toVrmViseme('viseme_RR')).toBe('ou');
  });

  it('falls back to silence for a viseme it has never heard of', () => {
    // A closed mouth is the safe wrong answer: it is what a face does between words.
    expect(toVrmViseme('viseme_XX')).toBe('sil');
    expect(toVrmViseme('')).toBe('sil');
  });

  it('exposes the VRM set the renderer has to zero out', () => {
    expect(VRM_VISEMES).toEqual(['aa', 'ih', 'ou', 'ee', 'oh', 'sil']);
  });
});

describe('visemeWeight', () => {
  it('clamps to the unit interval', () => {
    // `features.volume` comes off FFT magnitudes and is not bounded by the library. A
    // weight above 1 is a blendshape driven past its authored extent.
    expect(visemeWeight(0.4)).toBeCloseTo(0.4, 6);
    expect(visemeWeight(3.2)).toBe(1);
    expect(visemeWeight(0.4, 10)).toBe(1);
  });

  it('treats silence and nonsense as a closed mouth', () => {
    expect(visemeWeight(0)).toBe(0);
    expect(visemeWeight(-0.5)).toBe(0);
    expect(visemeWeight(Number.NaN)).toBe(0);
  });
});

describe('smoothWeight', () => {
  it('closes half the distance in one half-life, whatever the frame rate', () => {
    // The property that makes the constant meaningful: the same 40 ms half-life has to
    // behave the same at 30 fps and at 144, or the mouth is tuned for one machine.
    const oneStep = smoothWeight(0, 1, 40, 40);
    expect(oneStep).toBeCloseTo(0.5, 6);

    let stepped = 0;
    for (let i = 0; i < 4; i += 1) stepped = smoothWeight(stepped, 1, 10, 40);
    expect(stepped).toBeCloseTo(oneStep, 6);
  });

  it('approaches the target and never overshoots it', () => {
    // An overshoot on a mouth expression is a face pulling a shape it does not have.
    let weight = 0;
    for (let i = 0; i < 200; i += 1) {
      weight = smoothWeight(weight, 1, 16, 40);
      expect(weight).toBeLessThanOrEqual(1);
    }
    expect(weight).toBeCloseTo(1, 4);
  });

  it('decays to a closed mouth rather than sticking open', () => {
    let weight = 1;
    for (let i = 0; i < 200; i += 1) weight = smoothWeight(weight, 0, 16, 40);
    expect(weight).toBeCloseTo(0, 4);
  });

  it('holds still on a zero-length frame instead of dividing by it', () => {
    expect(smoothWeight(0.3, 1, 0, 40)).toBe(0.3);
    expect(smoothWeight(0.3, 1, -16, 40)).toBe(0.3);
  });

  it('snaps when smoothing is switched off', () => {
    expect(smoothWeight(0.3, 1, 16, 0)).toBe(1);
  });
});
