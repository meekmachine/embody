import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import type { Texture, WebGLRenderTarget } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

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

export const DEFAULT_CHARACTER_LIGHTING_PRESETS = {
  cleanStudio: { id: 'cleanStudio', label: 'Soft Studio', settings: { envMapEnabled: true, environmentIntensity: .24, environmentBlur: .04, exposure: 1.08, ambientIntensity: .32, keyIntensity: .52, fillIntensity: .18, rimIntensity: .08, shadowOpacity: .22 } },
  softFill: { id: 'softFill', label: 'Soft Fill', settings: { envMapEnabled: true, environmentIntensity: .3, environmentBlur: .04, exposure: 1.1, ambientIntensity: .38, keyIntensity: .44, fillIntensity: .24, rimIntensity: .1, shadowOpacity: .18 } },
  inspection: { id: 'inspection', label: 'Inspection', settings: { envMapEnabled: true, environmentIntensity: .45, environmentBlur: .035, exposure: 1.18, ambientIntensity: .48, keyIntensity: .58, fillIntensity: .32, rimIntensity: .14, shadowOpacity: .12 } },
  contrast: { id: 'contrast', label: 'Contrast', settings: { envMapEnabled: true, environmentIntensity: .2, environmentBlur: .035, exposure: 1.08, ambientIntensity: .25, keyIntensity: .7, fillIntensity: .12, rimIntensity: .22, shadowOpacity: .28 } },
} as const;

export type DefaultCharacterLightingPresetId = keyof typeof DEFAULT_CHARACTER_LIGHTING_PRESETS;
export const DEFAULT_CHARACTER_LIGHTING_PRESET_ID: DefaultCharacterLightingPresetId = 'cleanStudio';
export const DEFAULT_CHARACTER_LIGHTING_PRESET_IDS = Object.keys(DEFAULT_CHARACTER_LIGHTING_PRESETS) as DefaultCharacterLightingPresetId[];
export const DEFAULT_CHARACTER_LIGHTING_SETTINGS: DefaultCharacterLightingSettings = { ...DEFAULT_CHARACTER_LIGHTING_PRESETS.cleanStudio.settings };

export const CHARACTER_SCENE_TYPES = {
  studio: { id: 'studio', label: 'Studio', description: 'Transparent background, soft studio lighting, ground shadow.', background: null, lightingPreset: 'cleanStudio', shadowPlane: true },
  showcase: { id: 'showcase', label: 'Showcase', description: 'Dark backdrop with contrasty key/rim lighting for presentation shots.', background: 0x101216, lightingPreset: 'contrast', shadowPlane: true },
  inspection: { id: 'inspection', label: 'Inspection', description: 'Bright, even lighting on a light backdrop for close-up review.', background: 0xe8eaed, lightingPreset: 'inspection', shadowPlane: true },
  void: { id: 'void', label: 'Void', description: 'Transparent background, soft fill lighting, no ground shadow.', background: null, lightingPreset: 'softFill', shadowPlane: false },
} as const;
export type CharacterSceneTypeId = keyof typeof CHARACTER_SCENE_TYPES;
export const CHARACTER_SCENE_TYPE_IDS = Object.keys(CHARACTER_SCENE_TYPES) as CharacterSceneTypeId[];
export const DEFAULT_CHARACTER_SCENE_TYPE_ID: CharacterSceneTypeId = 'studio';

const finite = (value: unknown, min: number, max: number, fallback: number) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? MathUtils.clamp(number, min, max) : fallback;
};

const normalize = (value: Partial<Record<keyof DefaultCharacterLightingSettings, unknown>>): DefaultCharacterLightingSettings => ({
  envMapEnabled: typeof value.envMapEnabled === 'boolean' ? value.envMapEnabled : DEFAULT_CHARACTER_LIGHTING_SETTINGS.envMapEnabled,
  environmentIntensity: finite(value.environmentIntensity, 0, 1.5, DEFAULT_CHARACTER_LIGHTING_SETTINGS.environmentIntensity),
  environmentBlur: finite(value.environmentBlur, 0, .04, DEFAULT_CHARACTER_LIGHTING_SETTINGS.environmentBlur),
  exposure: finite(value.exposure, .6, 2.2, DEFAULT_CHARACTER_LIGHTING_SETTINGS.exposure),
  ambientIntensity: finite(value.ambientIntensity, 0, 1.4, DEFAULT_CHARACTER_LIGHTING_SETTINGS.ambientIntensity),
  keyIntensity: finite(value.keyIntensity, 0, 2.2, DEFAULT_CHARACTER_LIGHTING_SETTINGS.keyIntensity),
  fillIntensity: finite(value.fillIntensity, 0, 1.6, DEFAULT_CHARACTER_LIGHTING_SETTINGS.fillIntensity),
  rimIntensity: finite(value.rimIntensity, 0, 1.6, DEFAULT_CHARACTER_LIGHTING_SETTINGS.rimIntensity),
  shadowOpacity: finite(value.shadowOpacity, 0, .5, DEFAULT_CHARACTER_LIGHTING_SETTINGS.shadowOpacity),
});

export const normalizeDefaultCharacterLightingSettings = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? normalize(value as Partial<Record<keyof DefaultCharacterLightingSettings, unknown>>)
    : null;

export function createShadowPlane(scene: Scene, options: { size?: number; opacity?: number; yPosition?: number } = {}) {
  const plane = new Mesh(new PlaneGeometry(options.size ?? 20, options.size ?? 20), new ShadowMaterial({ opacity: options.opacity ?? .3 }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = options.yPosition ?? -.01;
  plane.receiveShadow = true;
  plane.name = 'shadowPlane';
  scene.add(plane);
  return plane;
}

export function createDefaultCharacterLighting(scene: Scene, renderer: WebGLRenderer, initial: Partial<DefaultCharacterLightingSettings> = {}) {
  const ambient = new HemisphereLight(0xf7fbff, 0x6b7280, 0);
  const key = new DirectionalLight(0xfffbf4, 0);
  const fill = new DirectionalLight(0xe8f0ff, 0);
  const rim = new DirectionalLight(0xdde8ff, 0);
  ambient.name = 'embodyCharacterAmbientHemisphereLight'; ambient.position.set(0, 8, 0);
  key.name = 'embodyCharacterKeyLight'; key.position.set(4.5, 7.5, 6.2); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { near: .5, far: 50, left: -10, right: 10, top: 10, bottom: -10 }); key.shadow.bias = -.0001; key.shadow.radius = 4;
  fill.name = 'embodyCharacterFillLight'; fill.position.set(-5.5, 4.2, 4.5);
  rim.name = 'embodyCharacterRimLight'; rim.position.set(-3.5, 4.8, -5.4);
  scene.add(ambient, key, fill, rim);
  const pmrem = new PMREMGenerator(renderer);
  const listeners = new Set<(value: DefaultCharacterLightingSettings) => void>();
  let environment: WebGLRenderTarget | null = null;
  let settings = normalize({ ...DEFAULT_CHARACTER_LIGHTING_SETTINGS, ...initial });
  const rebuild = () => {
    environment?.dispose(); environment = null;
    if (!settings.envMapEnabled) { scene.environment = null; return; }
    const room = new RoomEnvironment();
    try { environment = pmrem.fromScene(room, settings.environmentBlur); } finally { room.dispose(); }
    scene.environment = environment.texture;
  };
  const apply = () => {
    renderer.outputColorSpace = SRGBColorSpace; renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = settings.exposure;
    scene.environmentIntensity = settings.envMapEnabled ? settings.environmentIntensity : 0;
    ambient.intensity = settings.ambientIntensity; key.intensity = settings.keyIntensity; fill.intensity = settings.fillIntensity; rim.intensity = settings.rimIntensity;
    const plane = scene.getObjectByName('shadowPlane') as Mesh | undefined;
    for (const material of plane ? (Array.isArray(plane.material) ? plane.material : [plane.material]) : []) if (material instanceof ShadowMaterial) material.opacity = settings.shadowOpacity;
  };
  rebuild(); apply();
  const setSettings = (patch: Partial<DefaultCharacterLightingSettings>) => {
    const previous = settings; settings = normalize({ ...settings, ...patch });
    if (previous.envMapEnabled !== settings.envMapEnabled || previous.environmentBlur !== settings.environmentBlur) rebuild();
    apply(); listeners.forEach((listener) => listener({ ...settings })); return { ...settings };
  };
  return {
    getSettings: () => ({ ...settings }), getEnvironmentTexture: (): Texture | null => environment?.texture ?? null,
    setSettings, setPreset: (id: DefaultCharacterLightingPresetId) => setSettings(DEFAULT_CHARACTER_LIGHTING_PRESETS[id]?.settings ?? {}),
    subscribe: (listener: (value: DefaultCharacterLightingSettings) => void) => { listeners.add(listener); listener({ ...settings }); return () => { listeners.delete(listener); }; },
    dispose: () => { listeners.clear(); environment?.dispose(); pmrem.dispose(); scene.environment = null; scene.remove(ambient, key, fill, rim); },
  };
}

export function createDefaultCharacterScene(container: HTMLElement, options: any = {}) {
  const sceneType = CHARACTER_SCENE_TYPES[options.type as CharacterSceneTypeId] ?? CHARACTER_SCENE_TYPES.studio;
  const width = Math.max(1, container.clientWidth || globalThis.innerWidth || 1);
  const height = Math.max(1, container.clientHeight || globalThis.innerHeight || 1);
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  const ratio = () => Math.min(globalThis.devicePixelRatio || 1, options.pixelRatioCap ?? 1.5);
  renderer.setPixelRatio(ratio()); renderer.setSize(width, height, true); renderer.shadowMap.enabled = options.shadows ?? true; renderer.shadowMap.type = PCFSoftShadowMap;
  container.appendChild(renderer.domElement); Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });
  const scene = new Scene(); const background = options.background === undefined ? sceneType.background : options.background; scene.background = background == null ? null : new Color(background);
  const camera = new PerspectiveCamera(options.cameraFov ?? 45, width / height, .1, 1000);
  const preset = DEFAULT_CHARACTER_LIGHTING_PRESETS[(options.lightingPreset ?? sceneType.lightingPreset) as DefaultCharacterLightingPresetId]?.settings ?? DEFAULT_CHARACTER_LIGHTING_SETTINGS;
  const lighting = createDefaultCharacterLighting(scene, renderer, { ...preset, ...options.lighting });
  const shadowPlane = (options.shadowPlane ?? sceneType.shadowPlane) ? createShadowPlane(scene, { opacity: lighting.getSettings().shadowOpacity }) : null;
  const resize = () => { const w = Math.max(1, container.clientWidth || globalThis.innerWidth || 1); const h = Math.max(1, container.clientHeight || globalThis.innerHeight || 1); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setPixelRatio(ratio()); renderer.setSize(w, h, false); };
  if (options.manageResize !== false) globalThis.addEventListener?.('resize', resize);
  return { container, scene, renderer, camera, lighting, shadowPlane, sceneType: sceneType.id, ownsScene: true, resize, dispose: () => { if (options.manageResize !== false) globalThis.removeEventListener?.('resize', resize); lighting.dispose(); if (shadowPlane) { scene.remove(shadowPlane); shadowPlane.geometry.dispose(); (Array.isArray(shadowPlane.material) ? shadowPlane.material : [shadowPlane.material]).forEach((material) => material.dispose()); } if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement); renderer.dispose(); } };
}
