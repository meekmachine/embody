import { PerspectiveCamera } from 'three';
import { createSceneInkBackground } from './sceneInkBackground';
import { resolveCharacterMaterialPalette, resolveCharacterTexturePalette } from './characterTexturePalette';
import type { Camera, Scene } from 'three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import { Embody } from './character';
import type { RustEmbodyHostConfig } from './character';
import { loadCharacterModel, applyCharacterModelTransform, disposeCharacterModel } from './model';
import type { CharacterModelLoadOptions, CharacterModelLoadResult, CharacterModelTransform } from './model';
import { normalizeRenderableCharacterMorphAttributes, assertRenderableCharacterMorphAttributes } from './modelMorphLayout';
import { validateMappings } from './authoring';
import { createDefaultCharacterSceneAsync } from './scene';
import type { CharacterSceneBackend, CharacterSceneConfiguration, CharacterSceneRenderer, CharacterSceneRenderingController, DefaultCharacterSceneAsyncOptions, ReadyDefaultCharacterScene } from './scene';
import { ThreeAnnotationController } from './annotations/ThreeAnnotationController';
import type { AnnotationCharacterConfig, ThreeAnnotationControllerConfig } from './annotations/types';
import type { Profile } from './authoringTypes';

export interface CharacterHostCharacterOptions extends CharacterModelTransform {
  modelUrl: string;
  presetType?: string;
  profile?: Partial<Profile>;
  annotationConfig?: AnnotationCharacterConfig;
  scene?: CharacterSceneConfiguration;
}
export interface CharacterHostExternalScene {
  scene: Scene;
  renderer: CharacterSceneRenderer;
  backend?: CharacterSceneBackend;
  rendering?: CharacterSceneRenderingController;
  camera: Camera;
  mountCanvas?: boolean;
  manageResize?: boolean;
  setSceneSettings?: (settings: CharacterSceneConfiguration) => void;
}
export type CharacterHostModelLoader = (modelUrl: string, options: CharacterModelLoadOptions & { signal: AbortSignal }) => Promise<CharacterModelLoadResult>;
export type CharacterHostPreparation = CharacterModelLoadResult & {
  engine: Embody;
  character: CharacterHostCharacterOptions;
  signal: AbortSignal;
};
export type CharacterHostReady = CharacterHostPreparation & {
  scene: Scene;
  camera: Camera;
  cameraController: ThreeAnnotationController | null;
  rendering: CharacterSceneRenderingController | null;
};
export interface CharacterHostOptions {
  signal?: AbortSignal;
  container: HTMLElement;
  character: CharacterHostCharacterOptions;
  embody?: RustEmbodyHostConfig;
  scene?: Omit<DefaultCharacterSceneAsyncOptions, 'signal'>;
  external?: CharacterHostExternalScene;
  loader?: CharacterModelLoadOptions;
  /** Storage authorization and byte caching remain with the application. */
  loadModel?: CharacterHostModelLoader;
  /** Replays authored mesh edits through the bound engine before GPU preparation. */
  prepareCharacter?: (context: CharacterHostPreparation) => void | Promise<void>;
  onCharacterReady?: (context: CharacterHostReady) => void | Promise<void>;
  /** Default true for compatibility. Editors can retain clips in a lazy catalog. */
  registerEmbeddedAnimations?: boolean;
  camera?: Omit<Partial<ThreeAnnotationControllerConfig>, 'scene' | 'camera' | 'renderer' | 'rendering' | 'domElement'>;
  autoStart?: boolean;
  renderLoop?: boolean;
  autoFrame?: boolean;
}
export interface CharacterHost extends CharacterModelLoadResult {
  engine: Embody;
  scene: Scene;
  readonly renderer: CharacterSceneRenderer | null;
  readonly backend: CharacterSceneBackend | null;
  readonly rendering: CharacterSceneRenderingController | null;
  camera: Camera;
  cameraController: ThreeAnnotationController | null;
  lighting: ReadyDefaultCharacterScene['lighting'] | null;
  ownsScene: boolean;
  container: HTMLElement;
  setCharacter(character: CharacterHostCharacterOptions, loader?: CharacterModelLoadOptions, signal?: AbortSignal): Promise<void>;
  resize(): void;
  dispose(): Promise<void>;
}

/** Acquire, prepare and reveal a character using the existing native render owner. */
export async function createCharacterHost(options: CharacterHostOptions): Promise<CharacterHost> {
  if (!options.container) throw new Error('createCharacterHost requires a container HTMLElement');
  if (!options.character?.modelUrl) throw new Error('createCharacterHost requires character.modelUrl');
  let loaded: CharacterModelLoadResult | undefined;
  let state: ReadyDefaultCharacterScene | CharacterHostExternalScene | undefined;
  let engine: Embody | undefined;
  let controller: ThreeAnnotationController | undefined;
  let host: CharacterHost | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let switching: Promise<void> = Promise.resolve();
  let activeChange: AbortController | undefined;
  let request = 0;
  let mountedCanvas: HTMLCanvasElement | undefined;
  const previousBackground = options.container.style?.background ?? '';
  let backgroundRevision = 0;
  const applyCharacterBackground = (value: CharacterModelLoadResult, character: CharacterHostCharacterOptions) => {
    const revision = ++backgroundRevision;
    const settings = sceneSettings(character);
    // Explicit appearance (including transparency) and external scenes remain authoritative.
    const usePalette = !options.external && settings.background === undefined
      && (settings.type === undefined || settings.type === 'studio');
    if (options.container.style) options.container.style.background = previousBackground;
    if (!usePalette) return;
    const background = createSceneInkBackground(css => {
      if (!disposed && revision === backgroundRevision && options.container.style) options.container.style.background = css;
    });
    const key = character.modelUrl;
    const materialPalette = resolveCharacterMaterialPalette(value.model, key);
    background.setPalette(materialPalette);
    void resolveCharacterTexturePalette(value.model, key).then(palette => {
      background.setPalette(palette ?? materialPalette);
      background.dispose();
    });
  };
  const visibility = new WeakMap<CharacterModelLoadResult['model'], boolean>();
  const lifetime = new AbortController();
  const initial = new AbortController();
  activeChange = initial;
  const aborted = () => new DOMException('Character host request was cancelled', 'AbortError');
  const cancel = () => { lifetime.abort(); activeChange?.abort(); };
  const cancelCreation = () => initial.abort();
  options.signal?.addEventListener('abort', cancelCreation, { once: true });
  if (options.signal?.aborted) cancelCreation();
  const check = (signal: AbortSignal) => { if (disposed || lifetime.signal.aborted || signal.aborted) throw aborted(); };
  const releaseModel = async (value: CharacterModelLoadResult) => {
    const release = () => disposeCharacterModel(state?.scene ?? null, value.model);
    if (state?.rendering) await state.rendering.releaseSceneResources(release);
    else release();
  };
  const acquireModel = (character: CharacterHostCharacterOptions, loader: CharacterModelLoadOptions | undefined, signal: AbortSignal) =>
    (options.loadModel ?? loadCharacterModel)(character.modelUrl, { ...loader, signal });
  const sceneSettings = (character: CharacterHostCharacterOptions): CharacterSceneConfiguration => {
    const { background, ...value } = { ...options.scene, ...character.scene };
    // Runtime factory options also accept Three.Color; saved character data does not.
    return { ...value, ...(background === undefined ? {} : {
      background: background && typeof background === 'object' ? background.getHex() : background,
    }) };
  };
  const acquireRenderer = async (signal: AbortSignal) => {
    const rendering = state?.rendering;
    if (!rendering) return undefined;
    try { await rendering.setSettings(rendering.getSettings()); }
    catch (error) { if (!rendering.getSnapshot().renderer) throw error; }
    check(signal);
    const lease = await rendering.acquireRendererAsync();
    try { check(signal); return lease; }
    catch (error) { lease.release(); throw error; }
  };
  const makeEngine = (value: CharacterModelLoadResult, character: CharacterHostCharacterOptions) => {
    let profile = character.profile ?? options.embody?.profile;
    let annotationConfig = character.annotationConfig;
    if (profile) {
      const bones: Array<{ name: string }> = [];
      value.model.traverse(object => { if ((object as { isBone?: boolean }).isBone && object.name) bones.push({ name: object.name }); });
      const validation = validateMappings(value.meshes, { bones }, profile, { suggestCorrections: true, useResolvedNames: true, minConfidence: 0.8 });
      if (validation.suggestedConfig && validation.corrections?.some(correction => correction.applied)) {
        profile = { ...profile, ...validation.suggestedConfig };
        if (annotationConfig) annotationConfig = { ...annotationConfig, ...validation.suggestedConfig };
      }
    }
    const resolvedCharacter = { ...character, profile, annotationConfig };
    const next = new Embody({ ...options.embody, presetType: character.presetType ?? options.embody?.presetType, profile });
    try {
      next.onReady({ model: value.model, meshes: value.meshes,
        ...(options.registerEmbeddedAnimations === false ? {} : { animations: value.animations }) });
      next.stop();
      return { next, character: resolvedCharacter };
    } catch (error) {
      try { next.dispose(); } catch { /* Preserve the binding failure. */ }
      throw error;
    }
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    backgroundRevision += 1;
    if (options.container.style) options.container.style.background = previousBackground;
    cancel();
    options.signal?.removeEventListener('abort', cancelCreation);
    disposal = (async () => {
      let failure: unknown;
      const attempt = async (release: () => unknown) => { try { await release(); } catch (error) { failure ??= error; } };
      // Cancel a preparation draw before joining an operation waiting on that draw.
      await attempt(() => controller?.dispose());
      await switching.catch(() => {});
      await attempt(() => engine?.dispose());
      const ownedScene = !options.external && state && 'dispose' in state ? state : undefined;
      if (ownedScene) await attempt(() => ownedScene.dispose());
      if (loaded) await attempt(() => releaseModel(loaded!));
      mountedCanvas?.remove();
      if (failure !== undefined) throw failure;
    })();
    return disposal;
  };
  const prepare = async (value: CharacterModelLoadResult, next: Embody, character: CharacterHostCharacterOptions, signal: AbortSignal) => {
    check(signal);
    state?.setSceneSettings?.(sceneSettings(character));
    visibility.set(value.model, value.model.visible);
    value.model.visible = false;
    value.model.userData.embodyCharacterModel = true;
    await options.prepareCharacter?.({ ...value, engine: next, character, signal });
    check(signal);
    normalizeRenderableCharacterMorphAttributes(value.model);
    assertRenderableCharacterMorphAttributes(value.model);
    // Authored morph replay can add meshes/targets. Inspect the final layout.
    if (options.prepareCharacter) next.bindModel();
    value.model.updateMatrixWorld(true);
    state!.scene.add(value.model);
    if (controller) await controller.prepareModelForRender(value.model, { signal });
    check(signal);
  };
  const frameCharacter = async (value: CharacterModelLoadResult, character: CharacterHostCharacterOptions) => {
    if (!controller) return;
    controller.setModel(value.model);
    if (character.annotationConfig) controller.prepareRegionsForReveal(character.annotationConfig);
    else if (options.autoFrame !== false) await controller.focusFullBody(0);
  };
  const ready = async (value: CharacterModelLoadResult, next: Embody, character: CharacterHostCharacterOptions, signal: AbortSignal) => {
    await frameCharacter(value, character);
    check(signal);
    await options.onCharacterReady?.({ ...value, engine: next, character, signal,
      scene: state!.scene, camera: state!.camera, cameraController: controller ?? null, rendering: state!.rendering ?? null });
    check(signal);
  };
  try {
    check(initial.signal);
    loaded = await acquireModel(options.character, options.loader, initial.signal);
    check(initial.signal);
    state = options.external ?? await createDefaultCharacterSceneAsync(options.container, { ...options.scene, ...options.character.scene, signal: initial.signal });
    check(initial.signal);
    await initEmbodyCore();
    check(initial.signal);
    if (options.external?.mountCanvas && !state.renderer.domElement.parentElement) {
      mountedCanvas = state.renderer.domElement;
      options.container.appendChild(mountedCanvas);
    }
    if (options.renderLoop ?? !options.external) {
      if (!(state.camera instanceof PerspectiveCamera)) throw new Error('Character host rendering requires a PerspectiveCamera');
      controller = new ThreeAnnotationController({ ...options.camera,
        scene: state.scene, camera: state.camera, domElement: state.renderer.domElement,
        ...(state.rendering ? { rendering: state.rendering } : { renderer: state.renderer }),
        showDOMControls: options.camera?.showDOMControls ?? false,
      });
    }
    applyCharacterModelTransform(loaded.model, options.character);
    loaded.model.updateMatrixWorld(true);
    const first = makeEngine(loaded, options.character);
    engine = first.next;
    let currentCharacter = first.character;
    const initialLease = await acquireRenderer(initial.signal);
    try {
      await prepare(loaded, engine, first.character, initial.signal);
      await ready(loaded, engine, first.character, initial.signal);
      loaded.model.visible = visibility.get(loaded.model) ?? true;
      applyCharacterBackground(loaded, first.character);
    } finally { initialLease?.release(); }
    if (options.autoStart !== false) engine.start();
    const sceneState = state;
    const rendering = state.rendering ?? null;
    host = {
      engine, scene: state.scene, camera: state.camera, cameraController: controller ?? null,
      get renderer() { return rendering ? rendering.getSnapshot().renderer : sceneState.renderer; },
      get backend() { return rendering ? rendering.getSnapshot().backend : sceneState.backend ?? null; },
      rendering, model: loaded.model, meshes: loaded.meshes, animations: loaded.animations, gltf: loaded.gltf,
      lighting: 'lighting' in state ? state.lighting : null,
      ownsScene: !options.external, container: options.container,
      resize() { if ('resize' in sceneState) sceneState.resize(); },
      setCharacter(character, loader = options.loader, signal) {
        if (disposed || lifetime.signal.aborted) return Promise.reject(aborted());
        if (!character.modelUrl) return Promise.reject(new Error('setCharacter requires character.modelUrl'));
        activeChange?.abort();
        const operation = new AbortController();
        const abort = () => operation.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        activeChange = operation;
        const generation = ++request;
        const change = switching.catch(() => {}).then(async () => {
          check(operation.signal);
          if (generation !== request) throw aborted();
          const next = await acquireModel(character, loader, operation.signal);
          let nextEngine: Embody | undefined;
          let lease: Awaited<ReturnType<typeof acquireRenderer>> = undefined;
          let cameraChanged = false;
          let previous: CharacterModelLoadResult | undefined;
          try {
            check(operation.signal);
            lease = await acquireRenderer(operation.signal);
            applyCharacterModelTransform(next.model, character);
            next.model.updateMatrixWorld(true);
            const prepared = makeEngine(next, character);
            nextEngine = prepared.next;
            await prepare(next, nextEngine, prepared.character, operation.signal);
            cameraChanged = true;
            await ready(next, nextEngine, prepared.character, operation.signal);
            check(operation.signal);
            previous = loaded!;
            engine!.dispose();
            engine = nextEngine;
            loaded = next;
            currentCharacter = prepared.character;
            applyCharacterBackground(next, currentCharacter);
            host!.engine = engine;
            host!.model = next.model;
            host!.meshes = next.meshes;
            host!.animations = next.animations;
            host!.gltf = next.gltf;
            previous.model.visible = false;
            next.model.visible = visibility.get(next.model) ?? true;
            if (options.autoStart !== false) engine.start();
          } catch (error) {
            if (loaded !== next) {
              try { state?.setSceneSettings?.(sceneSettings(currentCharacter)); } catch { /* Preserve replacement failure. */ }
              if (cameraChanged && !disposed && controller && loaded) {
                try { await frameCharacter(loaded, currentCharacter); } catch { /* Preserve replacement failure. */ }
              }
              try { nextEngine?.dispose(); } catch { /* Still release the acquired model. */ }
              lease?.release();
              lease = undefined;
              try { await releaseModel(next); } catch { /* Preserve the replacement failure. */ }
            }
            throw error;
          } finally { lease?.release(); }
          if (previous) await releaseModel(previous);
        });
        switching = change.finally(() => signal?.removeEventListener('abort', abort));
        return switching;
      },
      dispose,
    };
    options.signal?.removeEventListener('abort', cancelCreation);
    return host;
  } catch (error) {
    try { await dispose(); } catch { /* Preserve the acquisition error. */ }
    throw error;
  }
}
