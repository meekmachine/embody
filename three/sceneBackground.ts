import { Euler, type Scene } from 'three';

type Background = { value: Scene['background']; intensity: number; rotation: Euler };
type Override = { value: Background | null; onSceneDispose: () => void };
type Owner = { base: Background; override: Override | null; disposed: boolean };
const owners = new WeakMap<Scene, Owner>();
const snapshot = (scene: Scene): Background => ({ value: scene.background, intensity: scene.backgroundIntensity, rotation: scene.backgroundRotation.clone() });
const apply = (scene: Scene, value: Background) => {
  scene.background = value.value;
  scene.backgroundIntensity = value.intensity;
  scene.backgroundRotation.copy(value.rotation);
};
const ownerFor = (scene: Scene): Owner => {
  let owner = owners.get(scene);
  if (!owner) { owner = { base: snapshot(scene), override: null, disposed: false }; owners.set(scene, owner); }
  return owner;
};

/** Character settings update the inherited background even while scenery covers it. */
export function setSceneBaseBackground(scene: Scene, value: Scene['background']) {
  const owner = ownerFor(scene);
  owner.base = { value, intensity: 1, rotation: new Euler() };
  if (!owner.override?.value) apply(scene, owner.base);
}

/** One scenery owner per scene prevents competing capture-and-restore cleanups. */
export function acquireSceneBackground(scene: Scene, onSceneDispose: () => void) {
  const owner = ownerFor(scene);
  if (owner.disposed) throw new Error('The scenery scene has been disposed.');
  if (owner.override) throw new Error('The scene already has a scenery renderer.');
  owner.base = snapshot(scene);
  const override: Override = { value: null, onSceneDispose };
  owner.override = override;
  let disposed = false;
  return {
    set(value: Scene['background'], intensity: number, rotationDegrees: number) {
      if (disposed || owner.disposed) throw new Error('The scenery background has been disposed.');
      override.value = { value, intensity, rotation: new Euler(0, rotationDegrees * Math.PI / 180, 0) };
      apply(scene, override.value);
    },
    clear() {
      if (disposed) return;
      override.value = null;
      apply(scene, owner.base);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (owner.override === override) { owner.override = null; apply(scene, owner.base); }
    },
  };
}

/** Called by the scene's existing lifetime; the renderer owns its async drain. */
export function disposeSceneBackground(scene: Scene) {
  const owner = ownerFor(scene);
  if (owner.disposed) return;
  owner.disposed = true;
  owner.override?.onSceneDispose();
}
