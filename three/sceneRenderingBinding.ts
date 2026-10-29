import type { PerspectiveCamera, Scene } from 'three';
import type { CharacterSceneRenderer, CharacterSceneRenderingController } from './scene';

/** Adapter-private binding. Applications pass config.rendering to the camera controller. */
export type SceneRenderingBinding = {
  suspend(): Promise<void>;
  prepare(renderer: CharacterSceneRenderer): Promise<void>;
  commit(renderer: CharacterSceneRenderer): Promise<void>;
  onError(error: unknown): void;
};

type Owner = {
  scene: Scene;
  camera: PerspectiveCamera;
  binding: SceneRenderingBinding | null;
  disposed: boolean;
  drain: Promise<void> | null;
  settled: () => Promise<unknown> | null;
  reportFailure: (error: unknown, renderer?: CharacterSceneRenderer | null) => void;
};
const owners = new WeakMap<CharacterSceneRenderingController, Owner>();

export function registerSceneRendering(controller: CharacterSceneRenderingController, scene: Scene, camera: PerspectiveCamera, settled: () => Promise<unknown> | null, reportFailure: (error: unknown, renderer?: CharacterSceneRenderer | null) => void) {
  const owner: Owner = { scene, camera, binding: null, disposed: false, drain: null, settled, reportFailure };
  owners.set(controller, owner);
  return owner;
}

export function bindSceneRendering(controller: CharacterSceneRenderingController, scene: Scene, camera: PerspectiveCamera, binding: SceneRenderingBinding) {
  const owner = owners.get(controller);
  if (!owner || owner.disposed) throw new Error('Character scene rendering has been disposed or is not owned by Embody.');
  if (owner.scene !== scene || owner.camera !== camera) throw new Error('Rendering and camera controllers must share their scene and camera.');
  if (owner.binding) throw new Error('Character scene rendering already has a camera controller.');
  owner.binding = binding;
  const snapshot = controller.getSnapshot();
  if (snapshot.renderer) void binding.commit(snapshot.renderer).catch(binding.onError);
  if (snapshot.status !== 'ready' && snapshot.status !== 'error') void binding.suspend().catch(binding.onError);
  return () => {
    if (owner.binding === binding) {
      owner.drain = binding.suspend();
      void owner.drain.catch(() => undefined);
      owner.binding = null;
      return Promise.allSettled([owner.drain, owner.settled()]).then(() => undefined);
    }
    return null;
  };
}

export function reportSceneRenderingFailure(controller: CharacterSceneRenderingController, error: unknown, renderer?: CharacterSceneRenderer | null) {
  const owner = owners.get(controller);
  if (owner && !owner.disposed) owner.reportFailure(error, renderer);
}
