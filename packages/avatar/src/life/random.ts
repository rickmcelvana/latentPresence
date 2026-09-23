/**
 * A seeded source of randomness for the life layer.
 *
 * Seeded because every behaviour here is a distribution — blink intervals, glance
 * lengths, when the weight shifts — and a test of a distribution has to be able to run
 * the same minute twice. `Math.random` would make every such test either flaky or vague.
 */
export type Random = () => number;

/** mulberry32: small, fast, and plenty for choosing when to blink. Returns [0, 1). */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function between(random: Random, min: number, max: number): number {
  return min + (max - min) * random();
}

/**
 * An interval with a mean and some spread, never below `min`.
 *
 * Human intervals (between blinks, between glances) are skewed: mostly near the mean,
 * sometimes much longer, never zero. The sum of two uniforms gives the hump; the floor
 * keeps two events from landing on top of each other.
 */
export function interval(random: Random, mean: number, spread: number, min: number): number {
  const hump = (random() + random()) / 2; // 0..1, peaked at 0.5
  return Math.max(min, mean + (hump - 0.5) * 2 * spread);
}

export function chance(random: Random, probability: number): boolean {
  return random() < probability;
}
