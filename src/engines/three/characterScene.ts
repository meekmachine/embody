/**
 * Default Three.js scene host for Embody characters.
 *
 * Creates renderer / scene / camera / lighting / shadow plane and mounts the
 * canvas into a caller-supplied HTMLElement. Advanced callers can skip this
 * and inject an existing Three.js scene via createCharacterHost.
 */

import {
  ACESFilmicToneMapping,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  WebGLRenderer,
  type Texture,
  type WebGLRenderTarget,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type DefaultCharacterLightingPresetId =
  | 'cleanStudio'
  | 'softFill'
  | 'inspection'
  | 'contrast';

export interface DefaultCharacterLightingSettings {
  envMapEnabled: boolean;
  environmentIntensity: number;
  environmentBlur: number;
  exposure: number;
  ambientIntensity: number;
  keyIntensity: number;
  fillIntensity: number;
  rimIntensity: number;
  shadowOpacity: number;
}

export interface DefaultCharacterLightingController {
  getSettings: () => DefaultCharacterLightingSettings;
  getEnvironmentTexture: () => Texture | null;
  setSettings: (patch: Partial<DefaultCharacterLightingSettings>) => DefaultCharacterLightingSettings;
  setPreset: (presetId: DefaultCharacterLightingPresetId) => DefaultCharacterLightingSettings;
  subscribe: (listener: (settings: DefaultCharacterLightingSettings) => void) => () => void;
  dispose: () => void;
}

export interface DefaultCharacterSceneOptions {
  /** Perspective camera FOV. Default: 45 */
  cameraFov?: number;
  /** Cap device pixel ratio. Default: 1.5 */
  pixelRatioCap?: number;
  /** Enable shadow maps. Default: true */
  shadows?: boolean;
  /** Add a ground shadow receiver. Default: true */
  shadowPlane?: boolean;
  /** Initial lighting settings / overrides */
  lighting?: Partial<DefaultCharacterLightingSettings>;
  /** Lighting preset applied before lighting overrides. Default: cleanStudio */
  lightingPreset?: DefaultCharacterLightingPresetId;
  /** Listen for window resize. Default: true */
  manageResize?: boolean;
}

export interface DefaultCharacterScene {
  container: HTMLElement;
  scene: Scene;
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  lighting: DefaultCharacterLightingController;
  shadowPlane: Mesh | null;
  ownsScene: true;
  resize: () => void;
  dispose: () => void;
}

const LIGHT_NAMES = {
  ambient: 'embodyCharacterAmbientHemisphereLight',
  key: 'embodyCharacterKeyLight',
  fill: 'embodyCharacterFillLight',
  rim: 'embodyCharacterRimLight',
} as const;

export const DEFAULT_CHARACTER_LIGHTING_PRESET_ID: DefaultCharacterLightingPresetId = 'cleanStudio';

export const DEFAULT_CHARACTER_LIGHTING_PRESETS: Record<
  DefaultCharacterLightingPresetId,
  { id: DefaultCharacterLightingPresetId; label: string; settings: DefaultCharacterLightingSettings }
> = {
  cleanStudio: {
    id: 'cleanStudio',
    label: 'Soft Studio',
    settings: {
      envMapEnabled: true,
      environmentIntensity: 0.24,
      environmentBlur: 0.04,
      exposure: 1.08,
      ambientIntensity: 0.32,
      keyIntensity: 0.52,
      fillIntensity: 0.18,
      rimIntensity: 0.08,
      shadowOpacity: 0.22,
    },
  },
  softFill: {
    id: 'softFill',
    label: 'Soft Fill',
    settings: {
      envMapEnabled: true,
      environmentIntensity: 0.3,
      environmentBlur: 0.04,
      exposure: 1.1,
      ambientIntensity: 0.38,
      keyIntensity: 0.44,
      fillIntensity: 0.24,
      rimIntensity: 0.1,
      shadowOpacity: 0.18,
    },
  },
  inspection: {
    id: 'inspection',
    label: 'Inspection',
    settings: {
      envMapEnabled: true,
      environmentIntensity: 0.45,
      environmentBlur: 0.035,
      exposure: 1.18,
      ambientIntensity: 0.48,
      keyIntensity: 0.58,
      fillIntensity: 0.32,
      rimIntensity: 0.14,
      shadowOpacity: 0.12,
    },
  },
  contrast: {
    id: 'contrast',
    label: 'Contrast',
    settings: {
      envMapEnabled: true,
      environmentIntensity: 0.2,
      environmentBlur: 0.035,
      exposure: 1.08,
      ambientIntensity: 0.25,
      keyIntensity: 0.7,
      fillIntensity: 0.12,
      rimIntensity: 0.22,
      shadowOpacity: 0.28,
    },
  },
};

export const DEFAULT_CHARACTER_LIGHTING_SETTINGS: DefaultCharacterLightingSettings = {
  ...DEFAULT_CHARACTER_LIGHTING_PRESETS[DEFAULT_CHARACTER_LIGHTING_PRESET_ID].settings,
};

export const DEFAULT_CHARACTER_LIGHTING_PRESET_IDS: readonly DefaultCharacterLightingPresetId[] = [
  'cleanStudio',
  'softFill',
  'inspection',
  'contrast',
];

function cloneSettings(settings: DefaultCharacterLightingSettings): DefaultCharacterLightingSettings {
  return { ...settings };
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return MathUtils.clamp(numeric, min, max);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

type DefaultCharacterLightingSettingsInput = Partial<
  Record<keyof DefaultCharacterLightingSettings, unknown>
>;

function normalizeSettings(
  settings: DefaultCharacterLightingSettingsInput,
): DefaultCharacterLightingSettings {
  return {
    envMapEnabled: normalizeBoolean(settings.envMapEnabled, DEFAULT_CHARACTER_LIGHTING_SETTINGS.envMapEnabled),
    environmentIntensity: clampFinite(
      settings.environmentIntensity,
      0,
      1.5,
      DEFAULT_CHARACTER_LIGHTING_SETTINGS.environmentIntensity,
    ),
    environmentBlur: clampFinite(
      settings.environmentBlur,
      0,
      0.04,
      DEFAULT_CHARACTER_LIGHTING_SETTINGS.environmentBlur,
    ),
    exposure: clampFinite(settings.exposure, 0.6, 2.2, DEFAULT_CHARACTER_LIGHTING_SETTINGS.exposure),
    ambientIntensity: clampFinite(
      settings.ambientIntensity,
      0,
      1.4,
      DEFAULT_CHARACTER_LIGHTING_SETTINGS.ambientIntensity,
    ),
    keyIntensity: clampFinite(settings.keyIntensity, 0, 2.2, DEFAULT_CHARACTER_LIGHTING_SETTINGS.keyIntensity),
    fillIntensity: clampFinite(settings.fillIntensity, 0, 1.6, DEFAULT_CHARACTER_LIGHTING_SETTINGS.fillIntensity),
    rimIntensity: clampFinite(settings.rimIntensity, 0, 1.6, DEFAULT_CHARACTER_LIGHTING_SETTINGS.rimIntensity),
    shadowOpacity: clampFinite(settings.shadowOpacity, 0, 0.5, DEFAULT_CHARACTER_LIGHTING_SETTINGS.shadowOpacity),
  };
}

/**
 * Normalize persisted / untrusted lighting settings (e.g. profile JSON).
 * Returns null when the value is not a plain object.
 */
export function normalizeDefaultCharacterLightingSettings(
  value: unknown,
): DefaultCharacterLightingSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return normalizeSettings(value as DefaultCharacterLightingSettingsInput);
}

function setRendererLighting(renderer: WebGLRenderer, settings: DefaultCharacterLightingSettings): void {
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = settings.exposure;
}

function updateShadowPlaneOpacity(scene: Scene, opacity: number): void {
  const shadowPlane = scene.getObjectByName('shadowPlane');
  if (!(shadowPlane instanceof Mesh)) return;

  const materials = Array.isArray(shadowPlane.material) ? shadowPlane.material : [shadowPlane.material];
  materials.forEach((material) => {
    if (material instanceof ShadowMaterial) {
      material.opacity = opacity;
      material.needsUpdate = true;
    }
  });
}

function createLightRig(scene: Scene) {
  const ambient = new HemisphereLight(0xf7fbff, 0x6b7280, 0);
  ambient.name = LIGHT_NAMES.ambient;
  ambient.position.set(0, 8, 0);
  scene.add(ambient);

  const key = new DirectionalLight(0xfffbf4, 0);
  key.name = LIGHT_NAMES.key;
  key.position.set(4.5, 7.5, 6.2);
  key.castShadow = true;
  key.shadow.mapSize.width = 2048;
  key.shadow.mapSize.height = 2048;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 50;
  key.shadow.camera.left = -10;
  key.shadow.camera.right = 10;
  key.shadow.camera.top = 10;
  key.shadow.camera.bottom = -10;
  key.shadow.bias = -0.0001;
  key.shadow.radius = 4;
  scene.add(key);

  const fill = new DirectionalLight(0xe8f0ff, 0);
  fill.name = LIGHT_NAMES.fill;
  fill.position.set(-5.5, 4.2, 4.5);
  scene.add(fill);

  const rim = new DirectionalLight(0xdde8ff, 0);
  rim.name = LIGHT_NAMES.rim;
  rim.position.set(-3.5, 4.8, -5.4);
  scene.add(rim);

  return { ambient, key, fill, rim };
}

export function createShadowPlane(
  scene: Scene,
  options: { size?: number; opacity?: number; yPosition?: number } = {},
): Mesh {
  const { size = 20, opacity = 0.3, yPosition = -0.01 } = options;
  const shadowPlane = new Mesh(
    new PlaneGeometry(size, size),
    new ShadowMaterial({ opacity }),
  );
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = yPosition;
  shadowPlane.receiveShadow = true;
  shadowPlane.name = 'shadowPlane';
  scene.add(shadowPlane);
  return shadowPlane;
}

export function createDefaultCharacterLighting(
  scene: Scene,
  renderer: WebGLRenderer,
  initialSettings: Partial<DefaultCharacterLightingSettings> = DEFAULT_CHARACTER_LIGHTING_SETTINGS,
): DefaultCharacterLightingController {
  const lights = createLightRig(scene);
  const pmremGenerator = new PMREMGenerator(renderer);
  const listeners = new Set<(settings: DefaultCharacterLightingSettings) => void>();
  let environmentTarget: WebGLRenderTarget | null = null;
  let settings = normalizeSettings(initialSettings);

  const notify = () => {
    const nextSettings = cloneSettings(settings);
    listeners.forEach((listener) => listener(nextSettings));
  };

  const disposeEnvironmentTarget = () => {
    environmentTarget?.dispose();
    environmentTarget = null;
  };

  const rebuildEnvironment = () => {
    disposeEnvironmentTarget();
    if (!settings.envMapEnabled) {
      scene.environment = null;
      scene.environmentIntensity = 0;
      return;
    }

    const roomEnvironment = new RoomEnvironment();
    try {
      environmentTarget = pmremGenerator.fromScene(roomEnvironment, settings.environmentBlur);
    } finally {
      roomEnvironment.dispose();
    }

    scene.environment = environmentTarget.texture;
    scene.environmentIntensity = settings.environmentIntensity;
  };

  const applySettings = () => {
    setRendererLighting(renderer, settings);
    scene.environmentIntensity = settings.envMapEnabled ? settings.environmentIntensity : 0;
    lights.ambient.intensity = settings.ambientIntensity;
    lights.key.intensity = settings.keyIntensity;
    lights.fill.intensity = settings.fillIntensity;
    lights.rim.intensity = settings.rimIntensity;
    updateShadowPlaneOpacity(scene, settings.shadowOpacity);
  };

  rebuildEnvironment();
  applySettings();

  const setSettings = (
    patch: Partial<DefaultCharacterLightingSettings>,
  ): DefaultCharacterLightingSettings => {
    const nextSettings = normalizeSettings({ ...settings, ...patch });
    const shouldRebuildEnvironment =
      nextSettings.envMapEnabled !== settings.envMapEnabled ||
      nextSettings.environmentBlur !== settings.environmentBlur;

    settings = nextSettings;
    if (shouldRebuildEnvironment) {
      rebuildEnvironment();
    }
    applySettings();
    notify();
    return cloneSettings(settings);
  };

  return {
    getSettings: () => cloneSettings(settings),
    getEnvironmentTexture: () => environmentTarget?.texture ?? null,
    setSettings,
    setPreset: (presetId) => {
      const preset = DEFAULT_CHARACTER_LIGHTING_PRESETS[presetId];
      if (!preset) return cloneSettings(settings);
      return setSettings(preset.settings);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(cloneSettings(settings));
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      listeners.clear();
      disposeEnvironmentTarget();
      pmremGenerator.dispose();
      scene.environment = null;
      scene.remove(lights.ambient, lights.key, lights.fill, lights.rim);
    },
  };
}

function resolveContainerSize(container: HTMLElement): { width: number; height: number } {
  const width = container.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1);
  const height = container.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 1);
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

function setPixelRatio(renderer: WebGLRenderer, pixelRatioCap: number): void {
  const deviceRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  renderer.setPixelRatio(Math.min(deviceRatio, pixelRatioCap));
}

/**
 * Create a default Embody character scene mounted into `container`.
 */
export function createDefaultCharacterScene(
  container: HTMLElement,
  options: DefaultCharacterSceneOptions = {},
): DefaultCharacterScene {
  const {
    cameraFov = 45,
    pixelRatioCap = 1.5,
    shadows = true,
    shadowPlane: enableShadowPlane = true,
    lightingPreset = DEFAULT_CHARACTER_LIGHTING_PRESET_ID,
    lighting: lightingOverrides = {},
    manageResize = true,
  } = options;

  const { width, height } = resolveContainerSize(container);

  const renderer = new WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  setPixelRatio(renderer, pixelRatioCap);
  renderer.setSize(width, height, true);
  renderer.shadowMap.enabled = shadows;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';

  const scene = new Scene();
  scene.background = null;

  const camera = new PerspectiveCamera(cameraFov, width / height, 0.1, 1000);

  const presetSettings = DEFAULT_CHARACTER_LIGHTING_PRESETS[lightingPreset]?.settings
    ?? DEFAULT_CHARACTER_LIGHTING_SETTINGS;
  const lighting = createDefaultCharacterLighting(scene, renderer, {
    ...presetSettings,
    ...lightingOverrides,
  });

  const shadowPlane = enableShadowPlane
    ? createShadowPlane(scene, { opacity: lighting.getSettings().shadowOpacity })
    : null;

  const resize = () => {
    const next = resolveContainerSize(container);
    camera.aspect = next.width / next.height;
    camera.updateProjectionMatrix();
    setPixelRatio(renderer, pixelRatioCap);
    renderer.setSize(next.width, next.height, false);
  };

  const onResize = () => resize();
  if (manageResize && typeof window !== 'undefined') {
    window.addEventListener('resize', onResize);
  }

  return {
    container,
    scene,
    renderer,
    camera,
    lighting,
    shadowPlane,
    ownsScene: true,
    resize,
    dispose: () => {
      if (manageResize && typeof window !== 'undefined') {
        window.removeEventListener('resize', onResize);
      }
      lighting.dispose();
      if (shadowPlane) {
        scene.remove(shadowPlane);
        shadowPlane.geometry.dispose();
        const material = shadowPlane.material;
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose());
        } else {
          material.dispose();
        }
      }
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    },
  };
}
