import { AnimationClip } from 'three';
import type { Material, Mesh, Object3D } from 'three';
export declare const THREE_BLENDING_MODES: {
    readonly Normal: 1;
    readonly Additive: 2;
    readonly Subtractive: 3;
    readonly Multiply: 4;
    readonly None: 0;
};
type BoneEntry = {
    obj: Object3D;
    basePos: {
        x: number;
        y: number;
        z: number;
    };
    baseQuat: ReturnType<Object3D['quaternion']['clone']>;
    baseEuler: {
        x: number;
        y: number;
        z: number;
        order: string;
    };
};
export type ThreeModelInspection = {
    descriptor: Record<string, unknown>;
    meshByName: Map<string, Mesh>;
    allMeshes: Mesh[];
    morphMeshes: Mesh[];
    bones: Record<string, BoneEntry>;
    meshBindings: Map<number, Mesh>;
    morphBindings: Map<number, {
        mesh: Mesh;
        index: number;
    }>;
    boneBindings: Map<number, Object3D>;
    objectBindings: Map<number, Object3D>;
};
export declare class ThreeModelInspector {
    inspectModel(model: Object3D, options?: {
        meshes?: Mesh[];
        profile?: any;
    }): ThreeModelInspection;
}
export type ClipIRTrack = {
    id?: number;
    channelId?: number;
    target: {
        kind?: string;
        meshId?: number;
        morphTargetId?: number;
        boneId?: number;
        objectId?: number;
        property?: string;
    };
    valueType: string;
    times: number[];
    values: number[];
    interpolation?: string;
    sourceName?: string;
};
export type ClipIR = {
    name: string;
    durationSeconds?: number;
    tracks: ClipIRTrack[];
};
/**
 * Convert host-neutral ClipIR (concrete morph/bone tracks) into a Three.js
 * AnimationClip. The host AnimationMixer owns playback and lerping.
 */
export declare function createAnimationClipFromClipIR(clip: ClipIR, inspection: ThreeModelInspection): AnimationClip;
export declare function serializeAnimationClips(model: Object3D, clips: readonly AnimationClip[], inspection: ThreeModelInspection): {
    name: string;
    durationSeconds: number;
    channels: {
        id: number;
        kind: string;
        name: string;
    }[];
    tracks: Record<string, unknown>[];
}[];
type MaterialConfig = {
    renderOrder?: number;
    transparent?: boolean;
    opacity?: number;
    depthWrite?: boolean;
    depthTest?: boolean;
    blending?: keyof typeof THREE_BLENDING_MODES;
};
export declare class ThreeFrameApplier {
    private meshes;
    private morphs;
    private bones;
    private objects;
    private originalEmissive;
    setBindings(inspection: ThreeModelInspection): void;
    applyPackedMorphFrameDelta(values: ArrayLike<number>, stride?: number): void;
    applyPackedBoneFrameDelta(values: ArrayLike<number>, stride?: number): void;
    applySceneFrame(frame: string | Record<string, any>): void;
    applyMeshMaterialConfigs(root: Object3D, configs: Record<string, {
        material?: MaterialConfig;
    }>): void;
    getMeshMaterialConfig(root: Object3D, name: string): null;
    setMeshMaterialConfig(root: Object3D, name: string, config: MaterialConfig): void;
    setMeshVisible(root: Object3D, name: string, visible: boolean): void;
    highlightMesh(root: Object3D, name: string | null, color?: number, intensity?: number): void;
    applyHairAppearance(meshes: readonly Mesh[], appearance: any): void;
    addMorphTarget(root: Object3D, target: any, options?: any): number;
    private applyMaterial;
    private visitMesh;
}
export declare const collectMorphMeshes: (root: Object3D) => Mesh<import("three").BufferGeometry<import("three").NormalBufferAttributes>, Material | Material[], import("three").Object3DEventMap>[];
export * from './model';
export * from './scene';
