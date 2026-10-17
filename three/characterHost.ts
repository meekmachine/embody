import { PerspectiveCamera } from 'three';
import type { Camera, Scene } from 'three';
import { initEmbodyCore } from '../wasm/index';
import { Embody } from './character';
import type { RustEmbodyHostConfig } from './character';
import { loadCharacterModel, applyCharacterModelTransform, disposeCharacterModel } from './model';
import type { CharacterModelLoadOptions, CharacterModelLoadResult, CharacterModelTransform } from './model';
import { createDefaultCharacterSceneAsync } from './scene';
import type { CharacterSceneBackend, CharacterSceneRenderer, CharacterSceneRenderingController, DefaultCharacterSceneAsyncOptions, ReadyDefaultCharacterScene } from './scene';
import { DPthreeCameraController } from './annotations/DPthreeCameraController';
import type { Profile } from './authoringTypes';

export interface CharacterHostCharacterOptions extends CharacterModelTransform {
  modelUrl: string;
  presetType?: string;
  profile?: Profile;
}
export interface CharacterHostExternalScene {
  scene: Scene;
  renderer: CharacterSceneRenderer;
  backend?: CharacterSceneBackend;
  rendering?: CharacterSceneRenderingController;
  camera: Camera;
  mountCanvas?: boolean;
  manageResize?: boolean;
}
export interface CharacterHostOptions {
  signal?: AbortSignal;
  container: HTMLElement;
  character: CharacterHostCharacterOptions;
  embody?: RustEmbodyHostConfig;
  scene?: Omit<DefaultCharacterSceneAsyncOptions, 'signal'>;
  external?: CharacterHostExternalScene;
  loader?: CharacterModelLoadOptions;
  autoStart?: boolean;
  renderLoop?: boolean;
  autoFrame?: boolean;
}
export interface CharacterHost extends Omit<CharacterModelLoadResult, 'gltf'> {
  engine: Embody;
  scene: Scene;
  readonly renderer: CharacterSceneRenderer | null;
  readonly backend: CharacterSceneBackend | null;
  readonly rendering: CharacterSceneRenderingController | null;
  camera: Camera;
  lighting: ReadyDefaultCharacterScene['lighting'] | null;
  ownsScene: boolean;
  container: HTMLElement;
  setCharacter(character: CharacterHostCharacterOptions, loader?: CharacterModelLoadOptions): Promise<void>;
  resize(): void;
  dispose(): Promise<void>;
}

/** Acquire a character and bind it to the existing Three rendering integration. */
export async function createCharacterHost(options: CharacterHostOptions): Promise<CharacterHost> {
  if (!options.container) throw new Error('createCharacterHost requires a container HTMLElement');
  if (!options.character?.modelUrl) throw new Error('createCharacterHost requires character.modelUrl');
  let loaded: CharacterModelLoadResult | undefined;
  let state: ReadyDefaultCharacterScene | CharacterHostExternalScene | undefined;
  let engine: Embody | undefined;
  let controller: DPthreeCameraController | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let switching: Promise<void> = Promise.resolve();
  let mountedCanvas: HTMLCanvasElement | undefined;
  const aborted = () => new DOMException('Character host creation was aborted', 'AbortError');
  const checkCreation = () => { if (options.signal?.aborted) throw aborted(); };
  const releaseModel = async (value: CharacterModelLoadResult) => {
    const release = () => disposeCharacterModel(state?.scene ?? null, value.model);
    if (state?.rendering) await state.rendering.releaseSceneResources(release);
    else release();
  };
  const makeEngine = (value: CharacterModelLoadResult, character: CharacterHostCharacterOptions) => {
    const next = new Embody({ ...options.embody, presetType: character.presetType ?? options.embody?.presetType, profile: character.profile ?? options.embody?.profile });
    try { next.onReady(value); return next; }
    catch (error) {
      try { next.dispose(); } catch { /* Preserve the binding failure. */ }
      throw error;
    }
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    disposal = (async () => {
      let failure: unknown;
      const attempt = async (release: () => unknown) => { try { await release(); } catch (error) { failure ??= error; } };
      // Cancel a queued preparation draw before waiting for replacement. It
      // may otherwise wait indefinitely for a frame on a suspended surface.
      await attempt(() => controller?.dispose());
      await switching.catch(() => {});
      await attempt(() => engine?.dispose());
      const ownedScene = !options.external && state && 'dispose' in state ? state : undefined;
      if (ownedScene) await attempt(() => ownedScene.dispose());
      const lastModel = loaded;
      if (lastModel) await attempt(() => releaseModel(lastModel));
      mountedCanvas?.remove();
      if (failure !== undefined) throw failure;
    })();
    return disposal;
  };
  try {
    checkCreation();
    loaded = await loadCharacterModel(options.character.modelUrl, options.loader);
    checkCreation();
    state = options.external ?? await createDefaultCharacterSceneAsync(options.container, { ...options.scene, signal: options.signal });
    checkCreation();
    await initEmbodyCore();
    checkCreation();
    applyCharacterModelTransform(loaded.model, options.character);
    state.scene.add(loaded.model);
    engine = makeEngine(loaded, options.character);
    if (options.external?.mountCanvas && !state.renderer.domElement.parentElement) {
      mountedCanvas = state.renderer.domElement;
      options.container.appendChild(mountedCanvas);
    }
    // Borrowed scenes keep their existing render owner unless explicitly requested.
    if (options.renderLoop ?? !options.external) {
      if (!(state.camera instanceof PerspectiveCamera)) throw new Error('Character host rendering requires a PerspectiveCamera');
      controller = new DPthreeCameraController({
        scene: state.scene, camera: state.camera, domElement: state.renderer.domElement,
        ...(state.rendering ? { rendering: state.rendering } : { renderer: state.renderer }),
        showDOMControls: false,
      });
      controller.setModel(loaded.model);
      await controller.prepareModelForRender(loaded.model, { signal: options.signal });
      if (options.autoFrame !== false) await controller.focusFullBody(0);
    }
    checkCreation();
    if (options.autoStart === false) engine.stop();
    else engine.start();
    const sceneState = state;
    const rendering = state.rendering ?? null;
    const host: CharacterHost = {
      engine, scene: state.scene, camera: state.camera,
      get renderer() { return rendering ? rendering.getSnapshot().renderer : sceneState.renderer; },
      get backend() { return rendering ? rendering.getSnapshot().backend : sceneState.backend ?? null; },
      rendering, model: loaded.model, meshes: loaded.meshes, animations: loaded.animations,
      lighting: 'lighting' in state ? state.lighting : null,
      ownsScene: !options.external, container: options.container,
      resize() { if ('resize' in sceneState) sceneState.resize(); },
      setCharacter(character, loader = options.loader) {
        if (disposed) return Promise.reject(new Error('Character host is disposed'));
        const change = switching.catch(() => {}).then(async () => {
          if (disposed) throw new Error('Character host is disposed');
          const next = await loadCharacterModel(character.modelUrl, loader);
          let nextEngine: Embody | undefined;
          try {
            if (disposed) throw new Error('Character host is disposed');
            applyCharacterModelTransform(next.model, character);
            nextEngine = makeEngine(next, character);
            nextEngine.stop();
            sceneState.scene.add(next.model);
            if (controller) await controller.prepareModelForRender(next.model);
            if (disposed) throw new Error('Character host is disposed');
          } catch (error) {
            try { nextEngine?.dispose(); } catch { /* Still release the acquired model. */ }
            try { await releaseModel(next); } catch { /* Preserve the replacement failure. */ }
            throw error;
          }
          const previous = loaded!;
          try { engine!.dispose(); }
          catch (error) {
            try { nextEngine?.dispose(); } catch { /* Still release the uncommitted model. */ }
            try { await releaseModel(next); } catch { /* Preserve the retirement failure. */ }
            throw error;
          }
          engine = nextEngine!;
          loaded = next;
          host.engine = engine;
          host.model = next.model;
          host.meshes = next.meshes;
          host.animations = next.animations;
          controller?.setModel(next.model);
          if (options.autoStart !== false) engine.start();
          await releaseModel(previous);
          if (controller && options.autoFrame !== false) await controller.focusFullBody(0);
        });
        switching = change;
        return change;
      },
      dispose,
    };
    return host;
  } catch (error) {
    try { await dispose(); } catch { /* Preserve the acquisition error. */ }
    throw error;
  }
}
