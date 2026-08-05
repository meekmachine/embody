export declare const EMBODY_CORE_ABI_VERSION = 1;
export declare const PACKED_MORPH_FRAME_DELTA_STRIDE = 4;
export declare const PACKED_BONE_FRAME_DELTA_STRIDE = 9;
export declare const HAIR_CONFIG_STRIDE = 11;
export declare const HAIR_STATE_STRIDE = 4;
export declare const HAIR_HEAD_STATE_STRIDE = 5;
export declare const HAIR_MORPH_OUTPUT_STRIDE = 6;
export declare const MESH_PROPORTIONS_STRIDE = 16;
export declare const TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE = 10;
export declare const TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE = 4;
export declare const ANNOTATION_CAMERA_FRAMING_STRIDE = 7;
export declare const CAMERA_FLIGHT_SAMPLE_STRIDE = 7;
export declare const MARKER_VISIBILITY_FACTORS_STRIDE = 3;
export declare const MARKER_ENDPOINT_STRIDE = 3;
export declare const HAIR_COLOR_PRESETS: {
    natural_black: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    natural_brown: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    natural_blonde: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    natural_red: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    natural_gray: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    natural_white: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    neon_blue: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    neon_pink: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    neon_green: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    electric_purple: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
    fire_orange: {
        name: string;
        baseColor: string;
        emissive: string;
        emissiveIntensity: number;
    };
};
export declare const DEFAULT_HAIR_COLOR_APPEARANCE: {
    name: string;
    baseColor: string;
    emissive: string;
    emissiveIntensity: number;
};
export declare const CC4_HUMANOID_SKELETON_TEMPLATE: {
    id: string;
    sourceCharacterId: string;
    sourceAsset: string;
    sourceSkinName: string;
    bones: ({
        name: string;
        parent: null;
        translation: number[];
    } | {
        name: string;
        parent: string;
        translation: number[];
    })[];
};
export declare const HUMANOID_SKELETON_TEMPLATES: {
    id: string;
    sourceCharacterId: string;
    sourceAsset: string;
    sourceSkinName: string;
    bones: ({
        name: string;
        parent: null;
        translation: number[];
    } | {
        name: string;
        parent: string;
        translation: number[];
    })[];
}[];
type Core = Record<string, any> & {
    default?: (input?: unknown) => Promise<unknown>;
};
export declare function initEmbodyCore(): Promise<Core>;
export declare const getEmbodyCore: typeof initEmbodyCore;
export declare function requireInitializedEmbodyCore(): Core;
export declare function resetEmbodyCoreForTests(): void;
export {};
