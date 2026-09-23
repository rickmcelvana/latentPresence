import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ClipOptions } from '@latentpresence/protocol';
import { ClipPlayer } from './clip-player';

/** A one-second clip that slides a node along X, so its effect is readable in node. */
function slide(name: string, to: number): THREE.AnimationClip {
  const track = new THREE.VectorKeyframeTrack('body.position', [0, 1], [0, 0, 0, to, 0, 0]);
  return new THREE.AnimationClip(name, 1, [track]);
}

function rig(): { root: THREE.Object3D; body: THREE.Object3D; player: ClipPlayer } {
  const root = new THREE.Object3D();
  const body = new THREE.Object3D();
  body.name = 'body';
  root.add(body);
  const player = new ClipPlayer(root);
  player.add('right', slide('right', 1));
  player.add('left', slide('left', -1));
  return { root, body, player };
}

const ONCE: ClipOptions = { loop: false, crossfadeMs: 0, weight: 1 };
const LOOP: ClipOptions = { loop: true, crossfadeMs: 0, weight: 1 };

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('ClipPlayer', () => {
  it('rejects an unknown clip', async () => {
    await expect(rig().player.play('nope', ONCE)).rejects.toThrow(/unknown clip/);
  });

  it('actually moves the rig', () => {
    const { body, player } = rig();
    void player.play('right', ONCE);
    player.update(500);
    expect(body.position.x).toBeCloseTo(0.5);
  });

  it('resolves a one-shot when the mixer says it finished, and holds the last pose', async () => {
    const { body, player } = rig();
    const done = player.play('right', ONCE);
    player.update(900);
    expect(await settled(done)).toBe(false);
    player.update(200);
    expect(await settled(done)).toBe(true);
    player.update(500);
    expect(body.position.x).toBeCloseTo(1);
  });

  it('resolves a looping clip at once and keeps it going', async () => {
    const { body, player } = rig();
    await player.play('right', LOOP);
    player.update(1250);
    expect(body.position.x).toBeCloseTo(0.25);
  });

  it('resolves a one-shot that another clip replaces', async () => {
    const { player } = rig();
    const first = player.play('right', ONCE);
    void player.play('left', ONCE);
    expect(await settled(first)).toBe(true);
  });

  it('crossfades rather than snapping', () => {
    const { body, player } = rig();
    void player.play('right', LOOP);
    player.update(500);
    void player.play('left', { loop: true, crossfadeMs: 400, weight: 1 });
    player.update(200);
    // Halfway through the fade the two clips are blended: neither pure right nor pure left.
    const x = body.position.x;
    expect(x).toBeGreaterThan(-0.2);
    expect(x).toBeLessThan(0.7);
    player.update(400);
    expect(body.position.x).toBeLessThan(0);
  });

  it('scales a clip by its weight', () => {
    const { body, player } = rig();
    void player.play('right', { loop: false, crossfadeMs: 0, weight: 0.5 });
    player.update(1000);
    expect(body.position.x).toBeCloseTo(0.5);
  });

  it('releases a waiting caller on dispose', async () => {
    const { player } = rig();
    const done = player.play('right', ONCE);
    player.dispose();
    expect(await settled(done)).toBe(true);
  });
});
