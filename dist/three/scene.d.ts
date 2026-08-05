import { Mesh, PerspectiveCamera, PlaneGeometry, Scene, ShadowMaterial, WebGLRenderer } from 'three';
import type { Texture } from 'three';
export type DefaultCharacterLightingSettings = {
    envMapEnabled: boolean;
    environmentIntensity: number;
    environmentBlur: number;
    exposure: number;
    ambientIntensity: number;
    keyIntensity: number;
    fillIntensity: number;
    rimIntensity: number;
    shadowOpacity: number;
};
export declare const DEFAULT_CHARACTER_LIGHTING_PRESETS: {
    readonly cleanStudio: {
        readonly id: "cleanStudio";
        readonly label: "Soft Studio";
        readonly settings: {
            readonly envMapEnabled: true;
            readonly environmentIntensity: 0.24;
            readonly environmentBlur: 0.04;
            readonly exposure: 1.08;
            readonly ambientIntensity: 0.32;
            readonly keyIntensity: 0.52;
            readonly fillIntensity: 0.18;
            readonly rimIntensity: 0.08;
            readonly shadowOpacity: 0.22;
        };
    };
    readonly softFill: {
        readonly id: "softFill";
        readonly label: "Soft Fill";
        readonly settings: {
            readonly envMapEnabled: true;
            readonly environmentIntensity: 0.3;
            readonly environmentBlur: 0.04;
            readonly exposure: 1.1;
            readonly ambientIntensity: 0.38;
            readonly keyIntensity: 0.44;
            readonly fillIntensity: 0.24;
            readonly rimIntensity: 0.1;
            readonly shadowOpacity: 0.18;
        };
    };
    readonly inspection: {
        readonly id: "inspection";
        readonly label: "Inspection";
        readonly settings: {
            readonly envMapEnabled: true;
            readonly environmentIntensity: 0.45;
            readonly environmentBlur: 0.035;
            readonly exposure: 1.18;
            readonly ambientIntensity: 0.48;
            readonly keyIntensity: 0.58;
            readonly fillIntensity: 0.32;
            readonly rimIntensity: 0.14;
            readonly shadowOpacity: 0.12;
        };
    };
    readonly contrast: {
        readonly id: "contrast";
        readonly label: "Contrast";
        readonly settings: {
            readonly envMapEnabled: true;
            readonly environmentIntensity: 0.2;
            readonly environmentBlur: 0.035;
            readonly exposure: 1.08;
            readonly ambientIntensity: 0.25;
            readonly keyIntensity: 0.7;
            readonly fillIntensity: 0.12;
            readonly rimIntensity: 0.22;
            readonly shadowOpacity: 0.28;
        };
    };
};
export type DefaultCharacterLightingPresetId = keyof typeof DEFAULT_CHARACTER_LIGHTING_PRESETS;
export declare const DEFAULT_CHARACTER_LIGHTING_PRESET_ID: DefaultCharacterLightingPresetId;
export declare const DEFAULT_CHARACTER_LIGHTING_PRESET_IDS: DefaultCharacterLightingPresetId[];
export declare const DEFAULT_CHARACTER_LIGHTING_SETTINGS: DefaultCharacterLightingSettings;
export declare const CHARACTER_SCENE_TYPES: {
    readonly studio: {
        readonly id: "studio";
        readonly label: "Studio";
        readonly description: "Transparent background, soft studio lighting, ground shadow.";
        readonly background: null;
        readonly lightingPreset: "cleanStudio";
        readonly shadowPlane: true;
    };
    readonly showcase: {
        readonly id: "showcase";
        readonly label: "Showcase";
        readonly description: "Dark backdrop with contrasty key/rim lighting for presentation shots.";
        readonly background: 1053206;
        readonly lightingPreset: "contrast";
        readonly shadowPlane: true;
    };
    readonly inspection: {
        readonly id: "inspection";
        readonly label: "Inspection";
        readonly description: "Bright, even lighting on a light backdrop for close-up review.";
        readonly background: 15264493;
        readonly lightingPreset: "inspection";
        readonly shadowPlane: true;
    };
    readonly void: {
        readonly id: "void";
        readonly label: "Void";
        readonly description: "Transparent background, soft fill lighting, no ground shadow.";
        readonly background: null;
        readonly lightingPreset: "softFill";
        readonly shadowPlane: false;
    };
};
export type CharacterSceneTypeId = keyof typeof CHARACTER_SCENE_TYPES;
export declare const CHARACTER_SCENE_TYPE_IDS: CharacterSceneTypeId[];
export declare const DEFAULT_CHARACTER_SCENE_TYPE_ID: CharacterSceneTypeId;
export declare const normalizeDefaultCharacterLightingSettings: (value: unknown) => DefaultCharacterLightingSettings | null;
export declare function createShadowPlane(scene: Scene, options?: {
    size?: number;
    opacity?: number;
    yPosition?: number;
}): Mesh<PlaneGeometry, ShadowMaterial, import("three").Object3DEventMap>;
export declare function createDefaultCharacterLighting(scene: Scene, renderer: WebGLRenderer, initial?: Partial<DefaultCharacterLightingSettings>): {
    getSettings: () => {
        envMapEnabled: boolean;
        environmentIntensity: number;
        environmentBlur: number;
        exposure: number;
        ambientIntensity: number;
        keyIntensity: number;
        fillIntensity: number;
        rimIntensity: number;
        shadowOpacity: number;
    };
    getEnvironmentTexture: () => Texture | null;
    setSettings: (patch: Partial<DefaultCharacterLightingSettings>) => {
        envMapEnabled: boolean;
        environmentIntensity: number;
        environmentBlur: number;
        exposure: number;
        ambientIntensity: number;
        keyIntensity: number;
        fillIntensity: number;
        rimIntensity: number;
        shadowOpacity: number;
    };
    setPreset: (id: DefaultCharacterLightingPresetId) => {
        envMapEnabled: boolean;
        environmentIntensity: number;
        environmentBlur: number;
        exposure: number;
        ambientIntensity: number;
        keyIntensity: number;
        fillIntensity: number;
        rimIntensity: number;
        shadowOpacity: number;
    };
    subscribe: (listener: (value: DefaultCharacterLightingSettings) => void) => () => void;
    dispose: () => void;
};
export declare function createDefaultCharacterScene(container: HTMLElement, options?: any): {
    container: HTMLElement;
    scene: Scene;
    renderer: WebGLRenderer;
    camera: PerspectiveCamera;
    lighting: {
        getSettings: () => {
            envMapEnabled: boolean;
            environmentIntensity: number;
            environmentBlur: number;
            exposure: number;
            ambientIntensity: number;
            keyIntensity: number;
            fillIntensity: number;
            rimIntensity: number;
            shadowOpacity: number;
        };
        getEnvironmentTexture: () => Texture | null;
        setSettings: (patch: Partial<DefaultCharacterLightingSettings>) => {
            envMapEnabled: boolean;
            environmentIntensity: number;
            environmentBlur: number;
            exposure: number;
            ambientIntensity: number;
            keyIntensity: number;
            fillIntensity: number;
            rimIntensity: number;
            shadowOpacity: number;
        };
        setPreset: (id: DefaultCharacterLightingPresetId) => {
            envMapEnabled: boolean;
            environmentIntensity: number;
            environmentBlur: number;
            exposure: number;
            ambientIntensity: number;
            keyIntensity: number;
            fillIntensity: number;
            rimIntensity: number;
            shadowOpacity: number;
        };
        subscribe: (listener: (value: DefaultCharacterLightingSettings) => void) => () => void;
        dispose: () => void;
    };
    shadowPlane: Mesh<PlaneGeometry, ShadowMaterial, import("three").Object3DEventMap> | null;
    sceneType: "inspection" | "studio" | "showcase" | "void";
    ownsScene: boolean;
    resize: () => void;
    dispose: () => void;
};
