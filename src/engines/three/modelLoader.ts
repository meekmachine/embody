/**
 * Character model loader for Embody hosts.
 *
 * Loads GLB/GLTF (optional Draco) and FBX, collects morph meshes, and provides
 * dispose helpers. App-specific asset routing (CDN aliases, HTML probing) stays
 * outside Embody — pass a resolved URL or ArrayBuffer.
 */

import {
  Box3,
  type AnimationClip,
  type Mesh,
  type Object3D,
  type Scene,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { collectMorphMeshes } from './Embody';

export interface CharacterModelLoadResult {
  model: Object3D;
  meshes: Mesh[];
  animations: AnimationClip[];
  gltf: GLTF | null;
}

export interface CharacterModelLoadOptions {
  /** Load progress callback (0-100). */
  onProgress?: (progress: number) => void;
  /** Enable shadow casting on meshes. Default: true */
  castShadows?: boolean;
  /** Draco decoder base path. Default: '/draco-gltf/' */
  dracoDecoderPath?: string;
}

export interface CharacterModelTransform {
  modelOffset?: { x?: number; y?: number; z?: number };
  modelRotation?: { x?: number; y?: number; z?: number };
  /**
   * Uniform model scale applied on the root.
   * Defaults to leaving the current scale untouched when omitted.
   */
  modelScale?: number;
  /** Lift model so its lowest point clears this Y value. */
  modelGroundClearance?: number;
}

const DEFAULT_DRACO_DECODER_PATH = '/draco-gltf/';

let sharedDracoLoader: DRACOLoader | null = null;
let sharedDracoPath: string | null = null;
let sharedGltfLoader: GLTFLoader | null = null;
let sharedFbxLoader: FBXLoader | null = null;

function getDracoLoader(decoderPath: string): DRACOLoader {
  if (!sharedDracoLoader || sharedDracoPath !== decoderPath) {
    sharedDracoLoader?.dispose();
    sharedDracoLoader = new DRACOLoader()
      .setDecoderPath(decoderPath.endsWith('/') ? decoderPath : `${decoderPath}/`)
      .setDecoderConfig({ type: 'wasm' });
    sharedDracoPath = decoderPath;
    sharedGltfLoader = null;
  }
  return sharedDracoLoader;
}

function getGltfLoader(decoderPath: string): GLTFLoader {
  if (!sharedGltfLoader || sharedDracoPath !== decoderPath) {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(getDracoLoader(decoderPath));
    sharedGltfLoader = loader;
  }
  return sharedGltfLoader;
}

function getFbxLoader(): FBXLoader {
  if (!sharedFbxLoader) {
    sharedFbxLoader = new FBXLoader();
  }
  return sharedFbxLoader;
}

function createDistinctProgressReporter(
  onProgress?: (progress: number) => void,
): ((progress: number) => void) | undefined {
  if (!onProgress) return undefined;

  let lastProgress: number | null = null;
  return (progress: number) => {
    if (!Number.isFinite(progress)) return;
    const normalized = Math.min(100, Math.max(0, Math.round(progress)));
    if (normalized === lastProgress) return;
    lastProgress = normalized;
    onProgress(normalized);
  };
}

function isFbxUrl(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  return lowercaseUrl.endsWith('.fbx') || lowercaseUrl.includes('.fbx?');
}

function prepareLoadedModel(model: Object3D, castShadows: boolean): Mesh[] {
  model.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    if (castShadows) {
      mesh.castShadow = true;
    }
  });
  return collectMorphMeshes(model);
}

/**
 * Apply optional placement transforms used by character profiles.
 */
export function applyCharacterModelTransform(
  model: Object3D,
  transform: CharacterModelTransform = {},
): void {
  const { modelOffset, modelRotation, modelScale, modelGroundClearance } = transform;

  if (modelOffset) {
    model.position.set(modelOffset.x ?? 0, modelOffset.y ?? 0, modelOffset.z ?? 0);
  }

  if (modelRotation) {
    const deg2rad = Math.PI / 180;
    model.rotation.set(
      (modelRotation.x ?? 0) * deg2rad,
      (modelRotation.y ?? 0) * deg2rad,
      (modelRotation.z ?? 0) * deg2rad,
    );
  }

  if (modelScale !== undefined && Number.isFinite(modelScale) && modelScale > 0) {
    model.scale.setScalar(modelScale);
  }

  // Ground clearance runs after scale so bounds reflect the sized model.
  if (modelGroundClearance !== undefined && Number.isFinite(modelGroundClearance)) {
    model.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(model);
    if (Number.isFinite(bounds.min.y) && bounds.min.y < modelGroundClearance) {
      model.position.y += modelGroundClearance - bounds.min.y;
    }
  }
}

/**
 * Dispose a model graph and remove it from a scene when present.
 *
 * Handles any renderable object (Mesh, Points, Line, ...) and releases
 * textures referenced by materials.
 */
export function disposeCharacterModel(scene: Scene | null, model: Object3D): void {
  scene?.remove(model);
  model.traverse((obj) => {
    const holder = obj as Object3D & {
      geometry?: { dispose?: () => void };
      material?: MaterialLike | MaterialLike[];
    };
    holder.geometry?.dispose?.();
    if (!holder.material) return;
    const materials = Array.isArray(holder.material) ? holder.material : [holder.material];
    materials.forEach(disposeMaterialWithTextures);
  });
}

interface MaterialLike {
  dispose?: () => void;
}

function disposeMaterialWithTextures(material: MaterialLike): void {
  Object.values(material as Record<string, unknown>).forEach((value) => {
    const texture = value as { isTexture?: boolean; dispose?: () => void } | null;
    if (texture?.isTexture && typeof texture.dispose === 'function') {
      texture.dispose();
    }
  });
  material.dispose?.();
}

function loadGltf(
  url: string,
  options: CharacterModelLoadOptions,
): Promise<CharacterModelLoadResult> {
  const { onProgress, castShadows = true, dracoDecoderPath = DEFAULT_DRACO_DECODER_PATH } = options;
  const reportProgress = createDistinctProgressReporter(onProgress);
  const loader = getGltfLoader(dracoDecoderPath);

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf: GLTF) => {
        const model = gltf.scene;
        resolve({
          model,
          meshes: prepareLoadedModel(model, castShadows),
          animations: gltf.animations || [],
          gltf,
        });
      },
      (progressEvent: ProgressEvent) => {
        if (progressEvent.lengthComputable) {
          reportProgress?.((progressEvent.loaded / progressEvent.total) * 100);
        }
      },
      (error: unknown) => reject(error),
    );
  });
}

function loadFbx(
  url: string,
  options: CharacterModelLoadOptions,
): Promise<CharacterModelLoadResult> {
  const { onProgress, castShadows = true } = options;
  const reportProgress = createDistinctProgressReporter(onProgress);
  const loader = getFbxLoader();

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (fbxGroup) => {
        resolve({
          model: fbxGroup,
          meshes: prepareLoadedModel(fbxGroup, castShadows),
          animations: fbxGroup.animations || [],
          gltf: null,
        });
      },
      (progressEvent: ProgressEvent) => {
        if (progressEvent.lengthComputable) {
          reportProgress?.((progressEvent.loaded / progressEvent.total) * 100);
        }
      },
      (error: unknown) => reject(error),
    );
  });
}

/**
 * Load a character model from a URL (GLB/GLTF or FBX).
 */
export function loadCharacterModel(
  url: string,
  options: CharacterModelLoadOptions = {},
): Promise<CharacterModelLoadResult> {
  if (isFbxUrl(url)) {
    return loadFbx(url, options);
  }
  return loadGltf(url, options);
}

/**
 * Parse a character model from an already-fetched ArrayBuffer.
 */
export function parseCharacterModel(
  data: ArrayBuffer,
  resourcePath = '',
  options: CharacterModelLoadOptions = {},
): Promise<CharacterModelLoadResult> {
  const { castShadows = true, dracoDecoderPath = DEFAULT_DRACO_DECODER_PATH } = options;
  const loader = getGltfLoader(dracoDecoderPath);

  return new Promise((resolve, reject) => {
    loader.parse(
      data,
      resourcePath,
      (gltf: GLTF) => {
        const model = gltf.scene;
        resolve({
          model,
          meshes: prepareLoadedModel(model, castShadows),
          animations: gltf.animations || [],
          gltf,
        });
      },
      (error: unknown) => reject(error),
    );
  });
}
