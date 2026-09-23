import * as THREE from 'three';
import type { BoneRotations, LifeBone } from '../life';
import type { Vec3 } from '../gaze';

/**
 * Applies the life layer's rotations on top of whatever the bones already hold — a clip's
 * pose, or the rest pose — and takes them off again before the next frame.
 *
 * The taking-off is the point. A mixer only writes the bones its clip animates, so a bone
 * no clip touches keeps last frame's value; multiply an offset onto it every frame and it
 * spins away. So each frame is `restore()` (divide out exactly what was applied), then the
 * mixer, then `apply()`. A bone the clip did write is overwritten by the mixer and the
 * restore is harmless.
 */
export class AdditivePose {
  private readonly lookup: (bone: LifeBone) => THREE.Object3D | null;
  private readonly applied = new Map<THREE.Object3D, THREE.Quaternion>();
  private hips: { node: THREE.Object3D; offset: THREE.Vector3 } | null = null;
  private readonly euler = new THREE.Euler();

  constructor(lookup: (bone: LifeBone) => THREE.Object3D | null) {
    this.lookup = lookup;
  }

  restore(): void {
    for (const [node, rotation] of this.applied) {
      node.quaternion.multiply(rotation.invert());
    }
    this.applied.clear();
    if (this.hips !== null) {
      this.hips.node.position.sub(this.hips.offset);
      this.hips = null;
    }
  }

  /** Each layer is applied in order, so the first is nearest the bone's own pose. */
  apply(layers: readonly BoneRotations[], hipsOffset: Vec3 | null = null): void {
    this.restore();
    for (const layer of layers) {
      for (const [bone, rotation] of Object.entries(layer) as [LifeBone, Vec3][]) {
        const node = this.lookup(bone);
        if (node === null) continue;
        const q = new THREE.Quaternion().setFromEuler(this.euler.set(rotation[0], rotation[1], rotation[2]));
        node.quaternion.multiply(q);
        const previous = this.applied.get(node);
        this.applied.set(node, previous === undefined ? q : previous.multiply(q));
      }
    }
    const hips = this.lookup('hips');
    if (hipsOffset !== null && hips !== null) {
      const offset = new THREE.Vector3(hipsOffset[0], hipsOffset[1], hipsOffset[2]);
      hips.position.add(offset);
      this.hips = { node: hips, offset };
    }
  }
}
