import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { BodyRejectedError, type BodyReport, checkBody } from './body-check';

/**
 * Reading a file as a VRM body (P7-T02, ADR-59), for the renderer and for the picker, which
 * checks a person's own file before it is kept rather than after they try to wear it.
 */

/** Parses `url`, refusing anything that is not a glTF or carries no VRM data, in words. */
export async function readVrm(url: string, loadGltf: (url: string) => Promise<GLTF>): Promise<VRM> {
  let gltf: GLTF;
  try {
    gltf = await loadGltf(url);
  } catch (error) {
    throw new BodyRejectedError(`This file cannot be read as a VRM (${error instanceof Error ? error.message : String(error)}).`);
  }
  const vrm = gltf.userData['vrm'] as VRM | undefined;
  if (vrm === undefined) {
    VRMUtils.deepDispose(gltf.scene);
    throw new BodyRejectedError('This is a 3D model with no VRM data: it has no rig or face the call can drive.');
  }
  return vrm;
}

function defaultLoadGltf(url: string): Promise<GLTF> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader.loadAsync(url);
}

/** Loads a VRM only to check it (`checkBody`), and lets it go. Throws `BodyRejectedError`. */
export async function inspectBody(url: string, loadGltf: (url: string) => Promise<GLTF> = defaultLoadGltf): Promise<BodyReport> {
  const vrm = await readVrm(url, loadGltf);
  try {
    return checkBody(vrm);
  } finally {
    VRMUtils.deepDispose(vrm.scene);
  }
}
