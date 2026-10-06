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
import type { ColorRepresentation, RenderTarget, Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { registerSceneRendering } from './sceneRenderingBinding';

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

export type DefaultCharacterSceneOptions = {
  type?: CharacterSceneTypeId;
  background?: ColorRepresentation | null;
  cameraFov?: number;
  pixelRatioCap?: number;
  shadows?: boolean;
  lightingPreset?: DefaultCharacterLightingPresetId;
  lighting?: Partial<DefaultCharacterLightingSettings>;
  shadowPlane?: boolean;
  manageResize?: boolean;
};

export type DefaultCharacterSceneAsyncOptions = DefaultCharacterSceneOptions & {
  /** Auto (default) tries native WebGPU initialization, then falls back to WebGL. */
  renderer?: CharacterSceneRendererPreference;
  /** Persistent settings take precedence over the legacy renderer option. */
  rendering?: Partial<CharacterSceneRenderingSettings>;
  /** Cancels construction, not ownership of a successfully returned scene. */
  signal?: AbortSignal;
  /** Compatibility notification; rendering snapshots also expose device loss. */
  onDeviceLost?: (error: Error) => void;
};

export type CharacterSceneRenderer = WebGLRenderer | WebGPURenderer;
export type CharacterSceneBackend = 'webgl' | 'webgpu';
export type CharacterSceneRendererPreference = 'auto' | CharacterSceneBackend;

type CharacterScene<R extends CharacterSceneRenderer> = {
  container: HTMLElement;
  scene: Scene;
  renderer: R;
  camera: PerspectiveCamera;
  lighting: ReturnType<typeof createDefaultCharacterLighting>;
  shadowPlane: ReturnType<typeof createShadowPlane> | null;
  sceneType: CharacterSceneTypeId;
  ownsScene: true;
  resize: () => void;
  dispose: () => void;
};

export type DefaultCharacterScene = CharacterScene<WebGLRenderer>;
export type CharacterSceneRenderingSettings = { preference: CharacterSceneRendererPreference };
export type CharacterSceneRenderingStatus = 'initializing' | 'switching' | 'ready' | 'error' | 'lost' | 'disposed';
export type CharacterSceneRenderingSnapshot = {
  readonly settings: CharacterSceneRenderingSettings;
  readonly status: CharacterSceneRenderingStatus;
  readonly error: Error | null;
} & (
  | { readonly backend: 'webgl'; readonly renderer: WebGLRenderer }
  | { readonly backend: 'webgpu'; readonly renderer: WebGPURenderer }
  | { readonly backend: null; readonly renderer: null }
);
export type CharacterSceneRendererLease = { readonly renderer: CharacterSceneRenderer; release(): void };
export interface CharacterSceneRenderingController {
  getSettings(): CharacterSceneRenderingSettings;
  getSnapshot(): CharacterSceneRenderingSnapshot;
  setSettings(patch: Partial<CharacterSceneRenderingSettings>): Promise<CharacterSceneRenderingSnapshot>;
  subscribe(listener: (snapshot: CharacterSceneRenderingSnapshot) => void): () => void;
  /** Borrow for capture/readback; release in finally. Unavailable during switching/loss. */
  acquireRenderer(): CharacterSceneRendererLease;
}
export type DefaultCharacterSceneRuntimeOptions = DefaultCharacterSceneAsyncOptions;
export type DefaultCharacterSceneRuntime = Omit<CharacterScene<CharacterSceneRenderer>, 'renderer' | 'dispose'> & {
  readonly renderer: CharacterSceneRenderer | null;
  readonly backend: CharacterSceneBackend | null;
  dispose(): Promise<void>;
  readonly rendering: CharacterSceneRenderingController;
  readonly ready: Promise<CharacterSceneRenderingSnapshot>;
};
export type ReadyDefaultCharacterScene = (
  | (Omit<DefaultCharacterScene, 'dispose'> & { readonly backend: 'webgl' })
  | (Omit<CharacterScene<WebGPURenderer>, 'dispose'> & { readonly backend: 'webgpu' })
) & { readonly rendering: CharacterSceneRenderingController; dispose(): Promise<void> };

// Register each resource as it is acquired. A failing disposer must not prevent
// later resources from being released, and repeated disposal is harmless.
function createDisposer() {
  const callbacks: Array<() => void> = [];
  let disposed = false;
  return {
    add: (callback: () => void) => { callbacks.push(callback); },
    isDisposed: () => disposed,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      let failed = false;
      let firstError: unknown;
      for (const callback of callbacks.reverse()) {
        try { callback(); } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
      callbacks.length = 0;
      if (failed) throw firstError;
    },
  };
}

function rollback(dispose: () => void) {
  // Preserve the construction/preparation error after attempting all cleanup.
  try { dispose(); } catch { /* The original failure is more useful to callers. */ }
}

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
  return createCharacterLighting(scene, renderer, () => new PMREMGenerator(renderer), initial);
}

type ScenePMREM = { fromScene(scene: Scene, sigma?: number): RenderTarget; dispose(): void };

type LightingRenderer = {
  renderer: CharacterSceneRenderer;
  pmrem: ScenePMREM;
  environment: RenderTarget | null;
  revision: number;
  dispose(): void;
};

function createCharacterLighting(scene: Scene, renderer: CharacterSceneRenderer, createPMREM: () => ScenePMREM, initial: Partial<DefaultCharacterLightingSettings>) {
  const lighting = createMutableCharacterLighting(scene, initial);
  try { lighting.commit(lighting.prepare(renderer, createPMREM)); return lighting.controller; }
  catch (error) { rollback(lighting.controller.dispose); throw error; }
}

/** Lights/settings stay stable; only backend-specific environment resources move. */
function createMutableCharacterLighting(scene: Scene, initial: Partial<DefaultCharacterLightingSettings>) {
  const lifetime = createDisposer();
  try {
    const ambient = new HemisphereLight(0xf7fbff, 0x6b7280, 0);
    const key = new DirectionalLight(0xfffbf4, 0);
    const fill = new DirectionalLight(0xe8f0ff, 0);
    const rim = new DirectionalLight(0xdde8ff, 0);
    ambient.name = 'embodyCharacterAmbientHemisphereLight'; ambient.position.set(0, 8, 0);
    key.name = 'embodyCharacterKeyLight'; key.position.set(4.5, 7.5, 6.2); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { near: .5, far: 50, left: -10, right: 10, top: 10, bottom: -10 }); key.shadow.bias = -.0001; key.shadow.radius = 4;
    fill.name = 'embodyCharacterFillLight'; fill.position.set(-5.5, 4.2, 4.5);
    rim.name = 'embodyCharacterRimLight'; rim.position.set(-3.5, 4.8, -5.4);
    lifetime.add(() => scene.remove(ambient, key, fill, rim));
    for (const light of [key, fill, rim]) lifetime.add(() => light.dispose());
    scene.add(ambient, key, fill, rim);
    const listeners = new Set<(value: DefaultCharacterLightingSettings) => void>();
    lifetime.add(() => listeners.clear());
    let active: LightingRenderer | null = null;
    let held = false;
    let closed = false;
    let revision = 0;
    let settings = normalize({ ...DEFAULT_CHARACTER_LIGHTING_SETTINGS, ...initial });
    lifetime.add(() => { scene.environment = null; active?.dispose(); active = null; });
    const rebuild = (target: LightingRenderer) => {
      let environment: RenderTarget | null = null;
      if (settings.envMapEnabled) {
        const room = new RoomEnvironment();
        try { environment = target.pmrem.fromScene(room, settings.environmentBlur); } finally { room.dispose(); }
      }
      target.environment?.dispose(); target.environment = environment; target.revision = revision;
    };
    const show = (target: LightingRenderer | null) => {
      if (target) {
        target.renderer.outputColorSpace = SRGBColorSpace;
        target.renderer.toneMapping = ACESFilmicToneMapping;
        target.renderer.toneMappingExposure = settings.exposure;
      }
      scene.environment = target?.environment?.texture ?? null;
      scene.environmentIntensity = settings.envMapEnabled ? settings.environmentIntensity : 0;
      ambient.intensity = settings.ambientIntensity; key.intensity = settings.keyIntensity; fill.intensity = settings.fillIntensity; rim.intensity = settings.rimIntensity;
      const plane = scene.getObjectByName('shadowPlane') as Mesh | undefined;
      for (const material of plane ? (Array.isArray(plane.material) ? plane.material : [plane.material]) : []) if (material instanceof ShadowMaterial) material.opacity = settings.shadowOpacity;
    };
    const prepare = (renderer: CharacterSceneRenderer, createPMREM: () => ScenePMREM): LightingRenderer => {
      const resources = createDisposer();
      try {
        const pmrem = createPMREM(); resources.add(() => pmrem.dispose());
        const target: LightingRenderer = { renderer, pmrem, environment: null, revision, dispose: resources.dispose };
        resources.add(() => { target.environment?.dispose(); target.environment = null; });
        rebuild(target); return target;
      } catch (error) { rollback(resources.dispose); throw error; }
    };
    const setSettings = (patch: Partial<DefaultCharacterLightingSettings>) => {
      if (closed || lifetime.isDisposed()) throw new Error('Character lighting has been disposed.');
      const previous = settings; settings = normalize({ ...settings, ...patch }); revision++;
      if (!held) {
        if (active && (previous.envMapEnabled !== settings.envMapEnabled || previous.environmentBlur !== settings.environmentBlur)) rebuild(active);
        show(active);
      }
      listeners.forEach((listener) => listener({ ...settings })); return { ...settings };
    };
    show(null);
    const controller = {
      getSettings: () => ({ ...settings }), getEnvironmentTexture: (): Texture | null => active?.environment?.texture ?? null,
      setSettings, setPreset: (id: DefaultCharacterLightingPresetId) => setSettings(DEFAULT_CHARACTER_LIGHTING_PRESETS[id]?.settings ?? {}),
      subscribe: (listener: (value: DefaultCharacterLightingSettings) => void) => {
        if (closed || lifetime.isDisposed()) throw new Error('Character lighting has been disposed.');
        listeners.add(listener); listener({ ...settings }); return () => { listeners.delete(listener); };
      },
      dispose: lifetime.dispose,
    };
    return {
      controller, prepare, show, close: () => { closed = true; }, revision: () => revision,
      hold: () => { held = true; },
      restore: () => {
        held = false;
        try { if (active && active.revision !== revision) rebuild(active); } finally { show(active); }
      },
      commit: (target: LightingRenderer) => {
        const previous = active; active = target; held = false; show(active);
        return previous;
      },
    };
  } catch (error) { rollback(lifetime.dispose); throw error; }
}

function constructDefaultCharacterScene<R extends CharacterSceneRenderer>(
  container: HTMLElement,
  options: DefaultCharacterSceneOptions,
  renderer: R,
  disposeRenderer: () => void,
  createLighting: (scene: Scene, settings: Partial<DefaultCharacterLightingSettings>) => ReturnType<typeof createDefaultCharacterLighting>,
) {
  const lifetime = createDisposer();
  lifetime.add(disposeRenderer);
  try {
    const sceneType = CHARACTER_SCENE_TYPES[options.type as CharacterSceneTypeId] ?? CHARACTER_SCENE_TYPES.studio;
    const width = Math.max(1, container.clientWidth || globalThis.innerWidth || 1);
    const height = Math.max(1, container.clientHeight || globalThis.innerHeight || 1);
    const ratio = () => Math.min(globalThis.devicePixelRatio || 1, options.pixelRatioCap ?? 1.5);
    renderer.setPixelRatio(ratio()); renderer.setSize(width, height, true); renderer.shadowMap.enabled = options.shadows ?? true; renderer.shadowMap.type = PCFSoftShadowMap;
    Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });
    const scene = new Scene(); const background = options.background === undefined ? sceneType.background : options.background; scene.background = background == null ? null : new Color(background);
    const camera = new PerspectiveCamera(options.cameraFov ?? 45, width / height, .1, 1000);
    const preset = DEFAULT_CHARACTER_LIGHTING_PRESETS[(options.lightingPreset ?? sceneType.lightingPreset) as DefaultCharacterLightingPresetId]?.settings ?? DEFAULT_CHARACTER_LIGHTING_SETTINGS;
    const lighting = createLighting(scene, { ...preset, ...options.lighting });
    lifetime.add(() => lighting.dispose());
    const shadowPlane = (options.shadowPlane ?? sceneType.shadowPlane) ? createShadowPlane(scene, { opacity: lighting.getSettings().shadowOpacity }) : null;
    if (shadowPlane) {
      lifetime.add(() => shadowPlane.material.dispose());
      lifetime.add(() => shadowPlane.geometry.dispose());
      lifetime.add(() => scene.remove(shadowPlane));
    }
    const resize = () => {
      if (lifetime.isDisposed()) return;
      const w = Math.max(1, container.clientWidth || globalThis.innerWidth || 1);
      const h = Math.max(1, container.clientHeight || globalThis.innerHeight || 1);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setPixelRatio(ratio()); renderer.setSize(w, h, false);
    };
    const handle: CharacterScene<R> = { container, scene, renderer, camera, lighting, shadowPlane, sceneType: sceneType.id, ownsScene: true, resize, dispose: lifetime.dispose };
    const attach = () => {
      lifetime.add(() => { if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement); });
      container.appendChild(renderer.domElement);
      if (options.manageResize !== false) {
        lifetime.add(() => globalThis.removeEventListener?.('resize', resize));
        globalThis.addEventListener?.('resize', resize);
      }
    };
    return { handle, attach };
  } catch (error) {
    rollback(lifetime.dispose);
    throw error;
  }
}

/** The existing synchronous WebGL path; it does not wait for shader compilation. */
export function createDefaultCharacterScene(container: HTMLElement, options: DefaultCharacterSceneOptions = {}): DefaultCharacterScene {
  const { handle, attach } = constructWebGLScene(container, options);
  try { attach(); return handle; } catch (error) {
    rollback(handle.dispose);
    throw error;
  }
}

function constructWebGLScene(container: HTMLElement, options: DefaultCharacterSceneOptions) {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  return constructDefaultCharacterScene(container, options, renderer, () => renderer.dispose(),
    (scene, settings) => createDefaultCharacterLighting(scene, renderer, settings));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Character scene creation was aborted.', 'AbortError');
}

type RendererCandidate = (
  | { backend: 'webgl'; renderer: WebGLRenderer }
  | { backend: 'webgpu'; renderer: WebGPURenderer }
) & { createPMREM(): ScenePMREM; dispose(): void; lost: Error | null };

function acquireWebGLRenderer(): RendererCandidate {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  const lifetime = createDisposer(); lifetime.add(() => renderer.dispose());
  return { backend: 'webgl', renderer, createPMREM: () => new PMREMGenerator(renderer), dispose: lifetime.dispose, lost: null };
}

// @types/three r184 omits this backend capability, which failed init still owns.
function disposeBackend(backend: object) {
  if ('dispose' in backend && typeof backend.dispose === 'function') backend.dispose();
}

async function acquireNativeRenderer(check: () => void, onLoss: (candidate: RendererCandidate) => void): Promise<RendererCandidate> {
  const lifetime = createDisposer();
  try {
    if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
      throw new Error('WebGPU is unavailable. Use WebGL or a browser with WebGPU in a secure context.');
    }
    const { WebGPURenderer, PMREMGenerator: WebGPUPMREMGenerator } = await import('three/webgpu');
    check();
    const renderer = new WebGPURenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    const initialBackend = renderer.backend;
    const candidate: RendererCandidate = {
      backend: 'webgpu', renderer, lost: null,
      createPMREM: () => new WebGPUPMREMGenerator(renderer), dispose: lifetime.dispose,
    };
    const originalDeviceLost = renderer.onDeviceLost.bind(renderer);
    renderer.onDeviceLost = (info) => {
      originalDeviceLost(info);
      if (lifetime.isDisposed() || candidate.lost) return;
      candidate.lost = new Error(`WebGPU device lost: ${info.message || 'Unknown reason'}`);
      onLoss(candidate);
    };
    lifetime.add(() => {
      try {
        if (renderer.hasInitialized()) renderer.dispose();
        else disposeBackend(renderer.backend);
      } finally {
        if (renderer.backend !== initialBackend) disposeBackend(initialBackend);
      }
    });
    await renderer.init(); check();
    if (candidate.lost) throw candidate.lost;
    if (!('isWebGPUBackend' in renderer.backend) || renderer.backend.isWebGPUBackend !== true) {
      throw new Error('Native WebGPU initialization failed; Three selected WebGL2. Select WebGL to retry.');
    }
    return candidate;
  } catch (error) { rollback(lifetime.dispose); check(); throw error; }
}

function renderingAborted() { return new DOMException('Character scene renderer request was cancelled.', 'AbortError'); }
function rendererPreference(value: unknown): CharacterSceneRendererPreference {
  if (value === 'auto' || value === 'webgl' || value === 'webgpu') return value;
  throw new Error(`Unsupported character scene renderer: ${String(value)}`);
}

/** Stable scene ownership, including a recoverable initial renderer failure. */
export function createDefaultCharacterSceneRuntime(
  container: HTMLElement,
  options: DefaultCharacterSceneRuntimeOptions = {},
): DefaultCharacterSceneRuntime {
  throwIfAborted(options.signal);
  const lifetime = createDisposer();
  try {
    const sceneType = CHARACTER_SCENE_TYPES[options.type as CharacterSceneTypeId] ?? CHARACTER_SCENE_TYPES.studio;
    const scene = new Scene();
    const background = options.background === undefined ? sceneType.background : options.background;
    scene.background = background == null ? null : new Color(background);
    const camera = new PerspectiveCamera(options.cameraFov ?? 45, 1, .1, 1000);
    const preset = DEFAULT_CHARACTER_LIGHTING_PRESETS[(options.lightingPreset ?? sceneType.lightingPreset) as DefaultCharacterLightingPresetId]?.settings ?? DEFAULT_CHARACTER_LIGHTING_SETTINGS;
    const lighting = createMutableCharacterLighting(scene, { ...preset, ...options.lighting });
    lifetime.add(lighting.controller.dispose);
    const shadowPlane = (options.shadowPlane ?? sceneType.shadowPlane) ? createShadowPlane(scene, { opacity: lighting.controller.getSettings().shadowOpacity }) : null;
    if (shadowPlane) {
      lifetime.add(() => shadowPlane.material.dispose());
      lifetime.add(() => shadowPlane.geometry.dispose());
      lifetime.add(() => scene.remove(shadowPlane));
    }
    let settings: CharacterSceneRenderingSettings = { preference: rendererPreference(options.rendering?.preference ?? options.renderer ?? 'auto') };
    let active: RendererCandidate | null = null;
    let candidateInUse: RendererCandidate | null = null;
    let status: CharacterSceneRenderingStatus = 'initializing';
    let error: Error | null = null;
    let disposed = false;
    let disposal: Promise<void> | null = null;
    let generation = 0;
    let pending: Promise<CharacterSceneRenderingSnapshot> | null = null;
    let leaseCount = 0;
    let leasesReleased: (() => void) | null = null;
    let leaseBarrier: Promise<void> | null = null;
    let resizeAttached = false;
    const listeners = new Set<(snapshot: CharacterSceneRenderingSnapshot) => void>();
    const getSnapshot = (): CharacterSceneRenderingSnapshot => {
      const common = { settings: { ...settings }, status, error };
      if (active?.backend === 'webgl') return { ...common, backend: 'webgl', renderer: active.renderer };
      if (active?.backend === 'webgpu') return { ...common, backend: 'webgpu', renderer: active.renderer };
      return { ...common, backend: null, renderer: null };
    };
    const notify = () => {
      const snapshot = getSnapshot();
      for (const listener of listeners) {
        try { listener(snapshot); } catch (failure) { console.error('Character rendering subscriber failed.', failure); }
      }
    };
    const sizeRenderer = (renderer: CharacterSceneRenderer, style = false) => {
      const w = Math.max(1, container.clientWidth || globalThis.innerWidth || 1);
      const h = Math.max(1, container.clientHeight || globalThis.innerHeight || 1);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, options.pixelRatioCap ?? 1.5));
      renderer.setSize(w, h, style);
    };
    const resize = () => { if (!disposed && active) sizeRenderer(active.renderer); };
    lifetime.add(() => { if (resizeAttached) globalThis.removeEventListener?.('resize', resize); });
    const onLoss = (candidate: RendererCandidate) => {
      if (disposed || candidate !== active) return;
      status = status === 'switching' ? 'switching' : 'lost'; error = candidate.lost;
      void Promise.resolve().then(() => candidate.renderer.setAnimationLoop(null)).catch(() => undefined);
      void owner.binding?.suspend().catch((failure) => console.error('Character renderer suspension failed.', failure));
      notify();
      try { options.onDeviceLost?.(candidate.lost!); } catch (failure) { console.error('Character scene device-loss callback failed.', failure); }
    };
    const setSettings = (patch: Partial<CharacterSceneRenderingSettings>): Promise<CharacterSceneRenderingSnapshot> => {
      if (disposed) return Promise.reject(renderingAborted());
      let preference: CharacterSceneRendererPreference;
      try { preference = patch.preference === undefined ? settings.preference : rendererPreference(patch.preference); }
      catch (failure) { return Promise.reject(failure); }
      if (pending && preference === settings.preference && (status === 'initializing' || status === 'switching')) return pending;
      if (status === 'ready' && preference === settings.preference) return Promise.resolve(getSnapshot());
      settings = { preference };
      const request = ++generation;
      const previous = pending;
      status = active ? 'switching' : 'initializing'; error = null;
      const execute = async (): Promise<CharacterSceneRenderingSnapshot> => {
        let candidate: RendererCandidate | null = null;
        let environment: LightingRenderer | null = null;
        let suspended = false;
        let attached = false;
        const check = () => {
          if (disposed || generation !== request) throw renderingAborted();
          if (!active) throwIfAborted(options.signal);
          if (candidate?.lost) throw candidate.lost;
        };
        try {
          check();
          if (preference === 'webgl') candidate = acquireWebGLRenderer();
          else {
            try { candidate = await acquireNativeRenderer(check, onLoss); }
            catch (failure) {
              check();
              if (preference !== 'auto' || (failure instanceof Error && failure.name === 'AbortError')) throw failure;
              candidate = acquireWebGLRenderer();
            }
          }
          check();
          candidateInUse = candidate;
          const renderer = candidate.renderer;
          sizeRenderer(renderer, true);
          renderer.shadowMap.enabled = options.shadows ?? true; renderer.shadowMap.type = PCFSoftShadowMap;
          Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });
          if (leaseCount) await leaseBarrier;
          check();
          if (owner.drain) await owner.drain;
          check();
          if (owner.binding) { suspended = true; await owner.binding.suspend(); }
          check();
          lighting.hold();
          // Environment changes during asynchronous compilation are deferred. If
          // authored settings changed meanwhile, prepare that revision before commit.
          do {
            environment?.dispose(); environment = lighting.prepare(renderer, candidate.createPMREM);
            lighting.show(environment);
            if (typeof renderer.compileAsync !== 'function') throw new Error('Async character scenes require Three.js WebGLRenderer.compileAsync.');
            await renderer.compileAsync(scene, camera); check();
            if (owner.binding) await owner.binding.prepare(renderer);
            else if (active) renderer.render(scene, camera);
            check();
          } while (environment.revision !== lighting.revision());
          sizeRenderer(renderer);
          // Stage the new canvas before removing the old one. A failed attach
          // or library binding leaves the old scene/renderer available.
          attached = true; container.appendChild(renderer.domElement);
          if (!resizeAttached && options.manageResize !== false) {
            resizeAttached = true; globalThis.addEventListener?.('resize', resize);
          }
          check();
          await owner.binding?.commit(renderer);
          check();
          const oldRenderer = active;
          const oldEnvironment = lighting.commit(environment); environment = null;
          active = candidate; candidate = null; attached = false;
          rollback(() => { if (oldRenderer?.renderer.domElement.parentElement === container) container.removeChild(oldRenderer.renderer.domElement); });
          rollback(() => oldEnvironment?.dispose());
          rollback(() => oldRenderer?.dispose());
          status = 'ready'; error = null;
          const snapshot = getSnapshot(); notify(); return snapshot;
        } catch (failure) {
          if (suspended) {
            try { await owner.binding?.suspend(); } catch { /* Preserve the switch failure. */ }
            if (owner.drain) await owner.drain.catch(() => undefined);
          }
          if (attached && candidate?.renderer.domElement.parentElement === container) container.removeChild(candidate.renderer.domElement);
          rollback(() => environment?.dispose());
          rollback(() => candidate?.dispose());
          const canceled = disposed || generation !== request || (!active && options.signal?.aborted);
          if (!disposed) {
            rollback(lighting.restore);
            if (suspended && active && !active.lost) {
              try { await owner.binding?.commit(active.renderer); } catch (resumeError) { owner.reportFailure(resumeError, active.renderer); }
            }
            if (generation === request) {
              status = active?.lost ? 'lost' : 'error';
              error = failure instanceof Error ? failure : new Error(String(failure)); notify();
            }
          }
          if (canceled) throw renderingAborted();
          throw failure;
        } finally { candidateInUse = null; }
      };
      const operation = previous ? previous.catch(() => undefined).then(execute) : Promise.resolve().then(execute);
      pending = operation;
      notify();
      void operation.then(() => { if (pending === operation) pending = null; }, () => { if (pending === operation) pending = null; });
      return operation;
    };
    const rendering: CharacterSceneRenderingController = {
      getSettings: () => ({ ...settings }), getSnapshot, setSettings,
      subscribe: (listener) => {
        if (disposed) throw new Error('Character scene rendering has been disposed.');
        listeners.add(listener);
        try { listener(getSnapshot()); } catch (failure) { console.error('Character rendering subscriber failed.', failure); }
        return () => { listeners.delete(listener); };
      },
      acquireRenderer: () => {
        if (!active || active.lost || disposed || (status !== 'ready' && status !== 'error')) throw new Error('Character renderer is not available for capture.');
        if (leaseCount++ === 0) leaseBarrier = new Promise<void>((resolve) => { leasesReleased = resolve; });
        let released = false;
        return { renderer: active.renderer, release: () => {
          if (released) return; released = true;
          if (--leaseCount === 0) { leasesReleased?.(); leasesReleased = null; leaseBarrier = null; }
        } };
      },
    };
    const owner = registerSceneRendering(rendering, scene, camera, () => pending, (failure, renderer) => {
      if (disposed) return;
      const problem = failure instanceof Error ? failure : new Error(String(failure));
      if (candidateInUse && renderer === candidateInUse.renderer && renderer !== active?.renderer) { candidateInUse.lost = problem; return; }
      if (active) active.lost = problem;
      status = active ? 'lost' : 'error'; error = problem;
      void owner.binding?.suspend().catch(() => undefined);
      notify();
    });
    const dispose = (): Promise<void> => {
      if (disposal) return disposal;
      let resolve!: () => void;
      let reject!: (failure: unknown) => void;
      disposal = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void disposal.catch(() => undefined);
      disposed = true; owner.disposed = true; generation++; lighting.close();
      status = 'disposed'; notify(); listeners.clear();
      const drain = owner.binding?.suspend() ?? owner.drain;
      const cleanup = () => {
        try {
          if (active?.renderer.domElement.parentElement === container) container.removeChild(active.renderer.domElement);
          try { lifetime.dispose(); } finally { active?.dispose(); }
          resolve();
        } catch (failure) { reject(failure); }
      };
      // Callers await this before releasing borrowed character resources. The
      // same completion also drains captures and a recently disposed camera.
      if (pending || leaseCount || drain) void Promise.allSettled([pending, drain, leaseBarrier]).then(cleanup);
      else cleanup();
      return disposal;
    };
    const ready = setSettings(settings);
    return { container, scene, camera, lighting: lighting.controller, shadowPlane, sceneType: sceneType.id, ownsScene: true,
      rendering, ready, get renderer() { return active?.renderer ?? null; }, get backend() { return active?.backend ?? null; }, resize, dispose };
  } catch (failure) { rollback(lifetime.dispose); throw failure; }
}

/** Compatibility factory: failure releases all owned resources. Use the runtime factory for initial retry. */
export async function createDefaultCharacterSceneAsync(
  container: HTMLElement,
  options: DefaultCharacterSceneAsyncOptions = {},
): Promise<ReadyDefaultCharacterScene> {
  const runtime = createDefaultCharacterSceneRuntime(container, options);
  try {
    const snapshot = await runtime.ready;
    if (!snapshot.renderer) throw new Error('Character scene renderer was not initialized.');
    const handle: ReadyDefaultCharacterScene = snapshot.backend === 'webgl'
      ? { ...runtime, renderer: snapshot.renderer, backend: 'webgl' }
      : { ...runtime, renderer: snapshot.renderer, backend: 'webgpu' };
    // Existing callers keep their non-null contract after first success. Read
    // rendering.getSnapshot() when an atomic backend/renderer pair is needed.
    Object.defineProperties(handle, {
      renderer: { get: () => runtime.renderer }, backend: { get: () => runtime.backend },
    });
    return handle;
  } catch (failure) {
    try { await runtime.dispose(); } catch { /* Preserve acquisition failure. */ }
    throw failure;
  }
}
