/**
 * High-level character host: default scene + model load + Embody binding.
 *
 * Default path: pass a container HTMLElement + character model URL.
 * Advanced path: inject an existing Three.js scene/renderer/camera.
 */

import {
  Box3,
  MathUtils,
  Vector3,
  type AnimationClip,
  type Camera,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { EmbodyConfig } from '../../interfaces/EmbodyRuntime';
import { getPresetWithProfile } from '../../presets';
import { Embody } from './Embody';
import {
  createDefaultCharacterScene,
  type DefaultCharacterLightingController,
  type DefaultCharacterSceneOptions,
} from './characterScene';
import {
  applyCharacterModelTransform,
  disposeCharacterModel,
  loadCharacterModel,
  type CharacterModelLoadOptions,
  type CharacterModelTransform,
} from './modelLoader';

export interface CharacterHostCharacterOptions extends CharacterModelTransform {
  /** Resolved model URL (GLB/GLTF/FBX). */
  modelUrl: string;
  /** Optional Embody preset / profile (also accepted via `embody`). */
  presetType?: EmbodyConfig['presetType'];
  profile?: EmbodyConfig['profile'];
}

export interface CharacterHostExternalScene {
  scene: Scene;
  renderer: WebGLRenderer;
  camera: Camera;
  /**
   * When true, host appends `renderer.domElement` into `container` if it is not
   * already mounted. Default: false.
   */
  mountCanvas?: boolean;
  /** When true, host listens for window resize. Default: false for external. */
  manageResize?: boolean;
}

export interface CharacterHostOptions {
  /** Element that receives the WebGL canvas in the default scene path. */
  container: HTMLElement;
  /** Character to load and bind. */
  character: CharacterHostCharacterOptions;
  /** Embody runtime config. `presetType` / `profile` on character win when both set. */
  embody?: EmbodyConfig;
  /** Default-scene options (ignored when `external` is provided). */
  scene?: DefaultCharacterSceneOptions;
  /** Advanced: inject an existing Three.js scene instead of creating one. */
  external?: CharacterHostExternalScene;
  /** Model loader options (progress, Draco path, shadows). */
  loader?: CharacterModelLoadOptions;
  /** Call `engine.start()` after binding. Default: true */
  autoStart?: boolean;
  /**
   * Run a requestAnimationFrame render loop (`renderer.render(scene, camera)`).
   * Default: true when Embody owns the scene, false when `external` is given.
   */
  renderLoop?: boolean;
  /**
   * Frame the camera on the loaded model (position + lookAt). Applies on every
   * `setCharacter`. Default: true when Embody owns the scene, false otherwise.
   */
  autoFrame?: boolean;
}

export interface CharacterHost {
  engine: Embody;
  scene: Scene;
  renderer: WebGLRenderer;
  camera: Camera | PerspectiveCamera;
  model: Object3D;
  meshes: Mesh[];
  animations: AnimationClip[];
  lighting: DefaultCharacterLightingController | null;
  /** True when Embody created and owns the default scene/renderer. */
  ownsScene: boolean;
  container: HTMLElement;
  /** Replace the loaded character while keeping the same scene/engine. */
  setCharacter: (character: CharacterHostCharacterOptions, loader?: CharacterModelLoadOptions) => Promise<void>;
  resize: () => void;
  dispose: () => void;
}

function resolveEmbodyConfig(
  options: CharacterHostOptions,
  character: CharacterHostCharacterOptions,
): EmbodyConfig {
  return {
    ...(options.embody ?? {}),
    ...(character.presetType ? { presetType: character.presetType } : {}),
    ...(character.profile ? { profile: character.profile } : {}),
  };
}

const AUTO_FRAME_PADDING = 1.2;

/** Position a perspective camera so the whole model is in view. */
function frameCameraOnModel(camera: Camera | PerspectiveCamera, model: Object3D): void {
  if (!('isPerspectiveCamera' in camera) || !(camera as PerspectiveCamera).isPerspectiveCamera) {
    return;
  }
  const perspective = camera as PerspectiveCamera;

  model.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(model);
  if (bounds.isEmpty()) return;

  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const halfFov = MathUtils.degToRad(perspective.fov) / 2;
  const aspect = perspective.aspect > 0 ? perspective.aspect : 1;
  const fitHeight = Math.max(size.y, 1e-3);
  const fitWidth = Math.max(size.x, 1e-3) / aspect;
  const distance = ((Math.max(fitHeight, fitWidth) / 2) / Math.tan(halfFov)) * AUTO_FRAME_PADDING;

  perspective.position.set(center.x, center.y + size.y * 0.05, center.z + distance);
  perspective.near = Math.max(distance / 100, 0.01);
  perspective.far = Math.max(distance * 10, 100);
  perspective.updateProjectionMatrix();
  perspective.lookAt(center);
}

function bindModelToEngine(
  engine: Embody,
  model: Object3D,
  meshes: Mesh[],
  animations: AnimationClip[],
): void {
  engine.onReady({ meshes, model });
  if (animations.length > 0) {
    engine.loadAnimationClips(animations);
  }
}

/**
 * Create a character host.
 *
 * Default: Embody creates the Three.js scene inside `container` and loads
 * `character.modelUrl`. Advanced: pass `external` with an existing scene.
 */
export async function createCharacterHost(options: CharacterHostOptions): Promise<CharacterHost> {
  const {
    container,
    character,
    external,
    scene: sceneOptions,
    loader: loaderOptions = {},
    autoStart = true,
  } = options;

  if (!container) {
    throw new Error('createCharacterHost requires a container HTMLElement');
  }
  if (!character?.modelUrl) {
    throw new Error('createCharacterHost requires character.modelUrl');
  }

  let scene: Scene;
  let renderer: WebGLRenderer;
  let camera: Camera | PerspectiveCamera;
  let lighting: DefaultCharacterLightingController | null = null;
  let ownsScene = false;
  let disposeDefaultScene: (() => void) | null = null;
  let resizeImpl: () => void = () => undefined;
  let removeResizeListener: (() => void) | null = null;

  if (external) {
    scene = external.scene;
    renderer = external.renderer;
    camera = external.camera;
    ownsScene = false;

    if (external.mountCanvas && renderer.domElement.parentElement !== container) {
      container.appendChild(renderer.domElement);
    }

    resizeImpl = () => {
      const width = Math.max(1, container.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1));
      const height = Math.max(1, container.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 1));
      if ('isPerspectiveCamera' in camera && (camera as PerspectiveCamera).isPerspectiveCamera) {
        const perspective = camera as PerspectiveCamera;
        perspective.aspect = width / height;
        perspective.updateProjectionMatrix();
      }
      renderer.setSize(width, height, false);
    };

    if (external.manageResize && typeof window !== 'undefined') {
      const onResize = () => resizeImpl();
      window.addEventListener('resize', onResize);
      removeResizeListener = () => window.removeEventListener('resize', onResize);
    }
  } else {
    const defaultScene = createDefaultCharacterScene(container, sceneOptions);
    scene = defaultScene.scene;
    renderer = defaultScene.renderer;
    camera = defaultScene.camera;
    lighting = defaultScene.lighting;
    ownsScene = true;
    disposeDefaultScene = defaultScene.dispose;
    resizeImpl = defaultScene.resize;
  }

  const shouldRenderLoop = options.renderLoop ?? !external;
  const shouldAutoFrame = options.autoFrame ?? !external;

  let renderFrameId: number | null = null;
  const startRenderLoop = () => {
    if (!shouldRenderLoop || renderFrameId !== null || typeof requestAnimationFrame === 'undefined') {
      return;
    }
    const renderFrame = () => {
      renderFrameId = requestAnimationFrame(renderFrame);
      renderer.render(scene, camera);
    };
    renderFrameId = requestAnimationFrame(renderFrame);
  };
  const stopRenderLoop = () => {
    if (renderFrameId !== null) {
      cancelAnimationFrame(renderFrameId);
      renderFrameId = null;
    }
  };

  const engine = new Embody(resolveEmbodyConfig(options, character));

  let model: Object3D | null = null;
  let meshes: Mesh[] = [];
  let animations: AnimationClip[] = [];
  let hasBoundCharacter = false;
  let activeCharacterKey = '';

  const characterConfigKey = (value: CharacterHostCharacterOptions): string =>
    JSON.stringify({
      modelUrl: value.modelUrl,
      presetType: value.presetType ?? null,
      profile: value.profile ?? null,
      modelOffset: value.modelOffset ?? null,
      modelRotation: value.modelRotation ?? null,
      modelScale: value.modelScale ?? null,
      modelGroundClearance: value.modelGroundClearance ?? null,
    });

  const setCharacter = async (
    nextCharacter: CharacterHostCharacterOptions,
    nextLoader: CharacterModelLoadOptions = loaderOptions,
  ): Promise<void> => {
    if (!nextCharacter?.modelUrl) {
      throw new Error('setCharacter requires character.modelUrl');
    }

    const loaded = await loadCharacterModel(nextCharacter.modelUrl, {
      ...loaderOptions,
      ...nextLoader,
    });

    applyCharacterModelTransform(loaded.model, nextCharacter);

    if (model) {
      disposeCharacterModel(scene, model);
    }

    model = loaded.model;
    meshes = loaded.meshes;
    animations = loaded.animations;
    scene.add(model);

    if (shouldAutoFrame) {
      frameCameraOnModel(camera, model);
    }

    const nextKey = characterConfigKey(nextCharacter);
    const shouldSwapProfile =
      hasBoundCharacter &&
      nextKey !== activeCharacterKey &&
      Boolean(nextCharacter.presetType || nextCharacter.profile);

    if (shouldSwapProfile) {
      // Swap presets in place so callers keep a stable `engine` reference.
      const config = resolveEmbodyConfig(options, nextCharacter);
      engine.setProfile(getPresetWithProfile(config.presetType, config.profile));
    }

    bindModelToEngine(engine, model, meshes, animations);
    hasBoundCharacter = true;
    activeCharacterKey = nextKey;
  };

  try {
    await setCharacter(character, loaderOptions);
  } catch (error) {
    disposeDefaultScene?.();
    removeResizeListener?.();
    engine.dispose();
    throw error;
  }

  if (autoStart) {
    engine.start();
  }
  startRenderLoop();

  return {
    engine,
    get scene() {
      return scene;
    },
    get renderer() {
      return renderer;
    },
    get camera() {
      return camera;
    },
    get model() {
      if (!model) throw new Error('Character host has no model bound');
      return model;
    },
    get meshes() {
      return meshes;
    },
    get animations() {
      return animations;
    },
    get lighting() {
      return lighting;
    },
    ownsScene,
    container,
    setCharacter,
    resize: () => resizeImpl(),
    dispose: () => {
      stopRenderLoop();
      engine.stop();
      engine.dispose();
      if (model) {
        disposeCharacterModel(scene, model);
        model = null;
      }
      removeResizeListener?.();
      if (ownsScene) {
        disposeDefaultScene?.();
      }
    },
  };
}
