import * as THREE from 'three';
import type { ClipOptions } from '@latentpresence/protocol';

interface Pending {
  readonly action: THREE.AnimationAction;
  readonly resolve: () => void;
}

/**
 * `playClip`'s rules over a three.js `AnimationMixer`, kept apart from the renderer so it
 * runs in node: a mixer needs an `Object3D` and nothing that draws.
 *
 * The rules are `FakeAvatarRenderer`'s, and the tests hold both to them: an unknown clip
 * rejects; a looping clip resolves at once; a one-shot resolves when it ends, or when
 * another clip replaces it — its caller is waiting for "done", and replaced is done.
 * A change crossfades over `crossfadeMs`; the blend graph with channels is P2-T03's.
 */
export class ClipPlayer {
  private readonly mixer: THREE.AnimationMixer;
  private readonly clips = new Map<string, THREE.AnimationClip>();
  private current: THREE.AnimationAction | null = null;
  private pending: Pending | null = null;

  constructor(root: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', (event) => {
      if (this.pending !== null && event.action === this.pending.action) this.settle();
    });
  }

  add(id: string, clip: THREE.AnimationClip): void {
    this.clips.set(id, clip);
  }

  has(id: string): boolean {
    return this.clips.has(id);
  }

  /**
   * Whether a clip owns the body: playing, or a one-shot holding its last pose. The rest
   * pose stands down while this is true, because a clip brings its own arms.
   */
  get posing(): boolean {
    return this.current !== null && this.current.enabled && this.current.getEffectiveWeight() > 0;
  }

  play(id: string, options: ClipOptions): Promise<void> {
    const clip = this.clips.get(id);
    if (clip === undefined) return Promise.reject(new Error(`unknown clip "${id}"`));

    const action = this.mixer.clipAction(clip);
    const previous = this.current;
    const fadeSeconds = options.crossfadeMs / 1000;

    this.settle();
    action.reset();
    action.setLoop(options.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    // A one-shot holds its last pose rather than snapping back to bind pose, so whatever
    // plays next fades from where the body actually is.
    action.clampWhenFinished = !options.loop;
    action.setEffectiveWeight(options.weight);
    action.play();

    if (previous !== null && previous !== action) {
      if (fadeSeconds > 0) {
        previous.fadeOut(fadeSeconds);
        action.fadeIn(fadeSeconds);
      } else {
        previous.stop();
      }
    }
    this.current = action;

    if (options.loop) return Promise.resolve();
    return new Promise((resolve) => {
      this.pending = { action, resolve };
    });
  }

  update(deltaMs: number): void {
    this.mixer.update(deltaMs / 1000);
  }

  /** Stops everything and resolves whoever is waiting, e.g. when the character changes. */
  dispose(): void {
    this.settle();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.current = null;
  }

  private settle(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve();
  }
}
