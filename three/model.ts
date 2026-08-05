import { Box3 } from 'three';
import type { AnimationClip, Mesh, Object3D, Scene } from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type CharacterModelLoadResult = { model: Object3D; meshes: Mesh[]; animations: AnimationClip[]; gltf: GLTF | null };
export type CharacterModelLoadOptions = { onProgress?: (progress: number) => void; castShadows?: boolean; dracoDecoderPath?: string };
export type CharacterModelTransform = { modelOffset?: { x?: number; y?: number; z?: number }; modelRotation?: { x?: number; y?: number; z?: number }; modelScale?: number; modelGroundClearance?: number };

let draco: DRACOLoader | null = null;
let dracoPath = '';
let gltfLoader: GLTFLoader | null = null;
let gltfLoaderUsesDraco = false;
let fbxLoader: FBXLoader | null = null;

const getGltfLoader = (dracoDecoderPath?: string) => {
  const wantsDraco = typeof dracoDecoderPath === 'string' && dracoDecoderPath.length > 0;
  const normalizedPath = wantsDraco
    ? (dracoDecoderPath!.endsWith('/') ? dracoDecoderPath! : `${dracoDecoderPath!}/`)
    : '';

  // Rebuild only when Draco enablement/path changes. Non-Draco assets must not
  // pay for constructing/attaching DRACOLoader at all.
  if (!gltfLoader || gltfLoaderUsesDraco !== wantsDraco || (wantsDraco && normalizedPath !== dracoPath)) {
    draco?.dispose();
    draco = null;
    dracoPath = normalizedPath;
    gltfLoaderUsesDraco = wantsDraco;
    gltfLoader = new GLTFLoader();
    if (wantsDraco) {
      draco = new DRACOLoader().setDecoderPath(normalizedPath).setDecoderConfig({ type: 'wasm' });
      gltfLoader.setDRACOLoader(draco);
    }
  }
  return gltfLoader;
};

const prepare = (model: Object3D, castShadows = true) => {
  const meshes: Mesh[] = [];
  model.traverse((object: any) => {
    if (!object.isMesh) return;
    if (castShadows) object.castShadow = true;
    if (object.morphTargetInfluences?.length) meshes.push(object);
  });
  return meshes;
};

const progress = (listener?: (progress: number) => void) => {
  let last = -1;
  return (event: ProgressEvent) => {
    if (!listener || !event.lengthComputable) return;
    const next = Math.min(100, Math.max(0, Math.round(event.loaded / event.total * 100)));
    if (next !== last) { last = next; listener(next); }
  };
};

export function applyCharacterModelTransform(model: Object3D, value: CharacterModelTransform = {}) {
  if (value.modelOffset) model.position.set(value.modelOffset.x ?? 0, value.modelOffset.y ?? 0, value.modelOffset.z ?? 0);
  if (value.modelRotation) model.rotation.set(...(['x', 'y', 'z'] as const).map((axis) => (value.modelRotation?.[axis] ?? 0) * Math.PI / 180) as [number, number, number]);
  if (Number.isFinite(value.modelScale) && (value.modelScale ?? 0) > 0) model.scale.setScalar(value.modelScale!);
  if (Number.isFinite(value.modelGroundClearance)) { model.updateMatrixWorld(true); const min = new Box3().setFromObject(model).min.y; if (Number.isFinite(min) && min < value.modelGroundClearance!) model.position.y += value.modelGroundClearance! - min; }
}

export function disposeCharacterModel(scene: Scene | null, model: Object3D) {
  scene?.remove(model);
  model.traverse((object: any) => {
    object.geometry?.dispose?.();
    for (const material of object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []) {
      for (const value of Object.values(material) as any[]) if (value?.isTexture) value.dispose?.();
      material.dispose?.();
    }
  });
}

export function loadCharacterModel(url: string, options: CharacterModelLoadOptions = {}): Promise<CharacterModelLoadResult> {
  const done = (model: Object3D, animations: AnimationClip[], gltf: GLTF | null) => ({ model, meshes: prepare(model, options.castShadows), animations, gltf });
  if (/\.fbx(?:\?|$)/i.test(url)) {
    fbxLoader ??= new FBXLoader();
    return new Promise((resolve, reject) => fbxLoader!.load(url, (model) => resolve(done(model, model.animations ?? [], null)), progress(options.onProgress), reject));
  }
  const loader = getGltfLoader(options.dracoDecoderPath);
  return new Promise((resolve, reject) => loader.load(url, (gltf) => resolve(done(gltf.scene, gltf.animations ?? [], gltf)), progress(options.onProgress), reject));
}

export function parseCharacterModel(data: ArrayBuffer, resourcePath = '', options: CharacterModelLoadOptions = {}): Promise<CharacterModelLoadResult> {
  const loader = getGltfLoader(options.dracoDecoderPath);
  return new Promise((resolve, reject) => loader.parse(data, resourcePath, (gltf) => resolve({ model: gltf.scene, meshes: prepare(gltf.scene, options.castShadows), animations: gltf.animations ?? [], gltf }), reject));
}
