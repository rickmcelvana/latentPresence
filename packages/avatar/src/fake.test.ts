import { describe, expect, it } from 'vitest';
import type { CharacterSource, ClipOptions } from '@latentpresence/protocol';
import { FakeAvatarRenderer, applyViseme } from './fake';

const SOURCE: CharacterSource = {
  id: 'alice',
  url: 'https://example.invalid/alice.vrm',
  format: 'vrm',
  licence: 'CC0-1.0',
  attribution: null,
};

const ONCE: ClipOptions = { loop: false, crossfadeMs: 200, weight: 1 };
const LOOP: ClipOptions = { loop: true, crossfadeMs: 200, weight: 1 };

async function ready(clips: Record<string, number> = {}): Promise<FakeAvatarRenderer> {
  const renderer = new FakeAvatarRenderer(clips);
  await renderer.mount('surface');
  await renderer.loadCharacter(SOURCE);
  return renderer;
}

/** Resolves to whether `promise` has settled, without waiting for it to. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('FakeAvatarRenderer — the AvatarRenderer rules', () => {
  it('refuses a character before it has a surface', async () => {
    await expect(new FakeAvatarRenderer().loadCharacter(SOURCE)).rejects.toThrow(/mount/);
  });

  it('refuses to drive a character before one is loaded', async () => {
    const renderer = new FakeAvatarRenderer();
    await renderer.mount('surface');
    expect(() => renderer.setExpression({ happy: 1 })).toThrow(/no character/);
    expect(() => renderer.setViseme('aa', 1)).toThrow(/no character/);
    expect(() => renderer.setGaze('away')).toThrow(/no character/);
    expect(() => renderer.playClip('idle', LOOP)).toThrow(/no character/);
  });

  it('keeps what it was told', async () => {
    const renderer = await ready();
    renderer.setExpression({ happy: 0.7 });
    renderer.setGaze('screen');
    expect(renderer.expression).toEqual({ happy: 0.7 });
    expect(renderer.gaze).toBe('screen');
    expect(renderer.character).toEqual(SOURCE);
  });

  it('rejects an unknown clip', async () => {
    const renderer = await ready();
    await expect(renderer.playClip('nope', ONCE)).rejects.toThrow(/unknown clip/);
  });

  it('resolves a looping clip at once', async () => {
    const renderer = await ready({ idle: 2000 });
    await expect(renderer.playClip('idle', LOOP)).resolves.toBeUndefined();
  });

  it('resolves a one-shot when it ends, and not before', async () => {
    const renderer = await ready({ wave: 1000 });
    const done = renderer.playClip('wave', ONCE);
    renderer.update(600);
    expect(await settled(done)).toBe(false);
    renderer.update(400);
    expect(await settled(done)).toBe(true);
  });

  it('resolves a one-shot that another clip replaces', async () => {
    const renderer = await ready({ wave: 1000, nod: 500 });
    const wave = renderer.playClip('wave', ONCE);
    void renderer.playClip('nod', ONCE);
    expect(await settled(wave)).toBe(true);
    expect(renderer.currentClip).toBe('nod');
  });

  it('is final once disposed, and releases a waiting clip', async () => {
    const renderer = await ready({ wave: 1000 });
    const wave = renderer.playClip('wave', ONCE);
    renderer.dispose();
    expect(await settled(wave)).toBe(true);
    expect(() => renderer.setGaze('user')).toThrow(/disposed/);
    expect(() => renderer.mount('again')).toThrow(/disposed/);
  });
});

describe('applyViseme', () => {
  const closed = new Map([
    ['aa', 0],
    ['ih', 0],
    ['ou', 0],
    ['ee', 0],
    ['oh', 0],
  ] as const);

  it('sets one shape and leaves the others, so a driver can blend two', () => {
    const mouth = applyViseme(applyViseme(closed, 'aa', 0.8), 'oh', 0.3);
    expect(mouth.get('aa')).toBe(0.8);
    expect(mouth.get('oh')).toBe(0.3);
  });

  it('closes the whole mouth on sil, whatever the weight', () => {
    const open = applyViseme(applyViseme(closed, 'aa', 0.8), 'ee', 0.5);
    const shut = applyViseme(open, 'sil', 0.2);
    expect([...shut.values()].every((value) => value === 0)).toBe(true);
  });

  it('clamps, and treats a non-finite weight as closed', () => {
    expect(applyViseme(closed, 'aa', 4).get('aa')).toBe(1);
    expect(applyViseme(closed, 'aa', Number.NaN).get('aa')).toBe(0);
  });
});
