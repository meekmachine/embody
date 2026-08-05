import type { AnimationClip, Mesh, Object3D, Scene } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
export type CharacterModelLoadResult = {
    model: Object3D;
    meshes: Mesh[];
    animations: AnimationClip[];
    gltf: GLTF | null;
};
export type CharacterModelLoadOptions = {
    onProgress?: (progress: number) => void;
    castShadows?: boolean;
    dracoDecoderPath?: string;
};
export type CharacterModelTransform = {
    modelOffset?: {
        x?: number;
        y?: number;
        z?: number;
    };
    modelRotation?: {
        x?: number;
        y?: number;
        z?: number;
    };
    modelScale?: number;
    modelGroundClearance?: number;
};
export declare function applyCharacterModelTransform(model: Object3D, value?: CharacterModelTransform): void;
export declare function disposeCharacterModel(scene: Scene | null, model: Object3D): void;
export declare function loadCharacterModel(url: string, options?: CharacterModelLoadOptions): Promise<CharacterModelLoadResult>;
export declare function parseCharacterModel(data: ArrayBuffer, resourcePath?: string, options?: CharacterModelLoadOptions): Promise<CharacterModelLoadResult>;
